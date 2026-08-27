/**
 * 本文件定义 Workspace 工作页跨进程复制协议及其前端 IPC 封装。
 * 只传递可重建页面的稳定描述，不传递页面 ID、Space、未保存正文或运行时资源。
 */

import type { Tab } from "@/modules/workbench";
import type { WorkspaceWindowMode } from "@/modules/settings/store";
import {
  currentWorkspaceBootstrap,
  nextWorkspaceWindowGeometry,
} from "@/modules/workspace-process";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

export type WorkspacePage =
  | {
      kind: "terminal";
      cwd?: string;
      blocks?: boolean;
      customTitle?: string;
    }
  | {
      kind: "editor";
      path: string;
      explorerRoot?: string;
    }
  | { kind: "markdown"; path: string; explorerRoot?: string }
  | { kind: "web-preview"; url: string };

export type WorkspaceRuntimeMessage =
  | { kind: "activate" }
  | { kind: "openFiles"; files: string[] }
  | { kind: "copyPage"; page: WorkspacePage };

export type TemporaryWorkspaceWindow = {
  id: string;
  openedAt: number;
};

export type WorkspacePageCopyBlockReason = "dirty" | "unsupported";

export type WorkspacePageHandoffMenuActions = {
  enabled: boolean;
  targets: TemporaryWorkspaceWindow[];
  refreshTargets: () => void;
  copyToWindow: (tabId: number, targetWindowId: string) => void;
  copyToNewWindow: (tabId: number) => void;
};

/** 将标签页转换为跨进程可重建描述，不支持的运行时页面返回明确原因。 */
export function workspacePageFromTab(
  tab: Tab,
): WorkspacePage | WorkspacePageCopyBlockReason {
  switch (tab.kind) {
    case "terminal":
      if (tab.private) return "unsupported";
      return {
        kind: "terminal",
        ...(tab.cwd !== undefined && { cwd: tab.cwd }),
        ...(tab.blocks && { blocks: true }),
        ...(tab.customTitle !== undefined && {
          customTitle: tab.customTitle,
        }),
      };
    case "editor":
      if (tab.dirty) return "dirty";
      return {
        kind: "editor",
        path: tab.path,
        ...(tab.explorerRoot !== undefined && {
          explorerRoot: tab.explorerRoot,
        }),
      };
    case "markdown":
      if (tab.dirty) return "dirty";
      return {
        kind: "markdown",
        path: tab.path,
        ...(tab.explorerRoot !== undefined && {
          explorerRoot: tab.explorerRoot,
        }),
      };
    case "web-preview":
      return { kind: "web-preview", url: tab.url };
    default:
      return "unsupported";
  }
}

/** 查询当前环境中可接收工作页的临时 Workspace 窗口。 */
export function listTemporaryWorkspaceWindows(): Promise<
  TemporaryWorkspaceWindow[]
> {
  return invoke("workspace_runtime_list_temporary_windows");
}

/** 将一个可重建工作页发送到已经运行的临时 Workspace 窗口。 */
export function sendWorkspacePage(
  targetWindowId: string,
  page: WorkspacePage,
): Promise<void> {
  return invoke("workspace_runtime_send_page", { targetWindowId, page });
}

/** 投递工作页并启动指定身份的新临时 Workspace 进程。 */
export async function spawnWorkspaceWindowWithPage(
  page: WorkspacePage,
): Promise<string> {
  const windowGeometry = await nextWorkspaceWindowGeometry();
  return invoke("workspace_runtime_spawn_with_page", {
    page,
    windowGeometry,
  });
}

/** 原子取走当前 Workspace 的定向消息。 */
export function takeWorkspaceRuntimeMessages(): Promise<
  WorkspaceRuntimeMessage[]
> {
  return invoke("workspace_runtime_take_messages");
}

/**
 * 监听运行时交换文件并串行触发消费。
 *
 * listener 建立后立即消费一次，覆盖目标进程启动前已经写入的消息；焦点事件作为
 * 文件系统通知的低频兜底。消费期间到达的新通知会在当前任务结束后再执行一次，
 * AbortSignal 用于避免 React 严格模式的过期 effect 消费消息。
 */
export async function onWorkspaceRuntimeChange(
  callback: () => void | Promise<void>,
  signal?: AbortSignal,
): Promise<UnlistenFn> {
  if (signal?.aborted) return () => {};

  let disposed = false;
  let running = false;
  let pending = false;
  let unlisten: UnlistenFn | null = null;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unlisten?.();
    window.removeEventListener("focus", schedule);
    signal?.removeEventListener("abort", dispose);
  };

  const run = async () => {
    if (disposed) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        try {
          await callback();
        } catch (error) {
          console.error(
            "[terax] Workspace runtime message handling failed:",
            error,
          );
        }
      } while (pending && !disposed);
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    void run();
  };
  unlisten = await listen("terax://workspace-runtime-changed", schedule);
  if (signal?.aborted) {
    dispose();
    return () => {};
  }
  window.addEventListener("focus", schedule);
  signal?.addEventListener("abort", dispose, { once: true });
  await run();

  return dispose;
}

type UseWorkspacePageHandoffParams = {
  ready: boolean;
  windowMode: WorkspaceWindowMode;
  getTab: (tabId: number) => Tab | undefined;
  openFiles: (files: string[]) => void | Promise<void>;
  openPage: (page: WorkspacePage) => void | Promise<void>;
};

/**
 * 协调主窗口发送菜单和所有 Workspace 窗口的定向消息消费。
 *
 * 消息只在 Workbench 准备完成后取走。发送成功表示已经写入交换文件，不等待目标确认；
 * 目标页面创建失败只影响这次复制，源页面始终保留。
 */
export function useWorkspacePageHandoff({
  ready,
  windowMode,
  getTab,
  openFiles,
  openPage,
}: UseWorkspacePageHandoffParams): WorkspacePageHandoffMenuActions | undefined {
  const { t } = useTranslation("tabs");
  const primary = currentWorkspaceBootstrap().isPrimary;
  const [targets, setTargets] = useState<TemporaryWorkspaceWindow[]>([]);

  const refreshTargets = useCallback(() => {
    if (!primary || windowMode !== "multiple") {
      setTargets([]);
      return;
    }
    void listTemporaryWorkspaceWindows()
      .then(setTargets)
      .catch((error) => {
        console.error("[terax] temporary Workspace listing failed:", error);
        setTargets([]);
      });
  }, [primary, windowMode]);

  const pageForCopy = useCallback(
    (tabId: number) => {
      const tab = getTab(tabId);
      return tab ? workspacePageFromTab(tab) : "unsupported";
    },
    [getTab],
  );

  const reportBlockedPage = useCallback(
    (reason: WorkspacePageCopyBlockReason) => {
      toast.error(
        t(
          reason === "dirty" ? "saveBeforeWindowCopy" : "windowCopyUnsupported",
        ),
      );
    },
    [t],
  );

  const copyToWindow = useCallback(
    (tabId: number, targetWindowId: string) => {
      const page = pageForCopy(tabId);
      if (typeof page !== "object") {
        reportBlockedPage(page);
        return;
      }
      void sendWorkspacePage(targetWindowId, page)
        .then(() => toast.success(t("windowCopySent")))
        .catch((error) => {
          console.error("[terax] Workspace page send failed:", error);
          toast.error(t("windowCopyFailed"));
          refreshTargets();
        });
    },
    [pageForCopy, refreshTargets, reportBlockedPage, t],
  );

  const copyToNewWindow = useCallback(
    (tabId: number) => {
      const page = pageForCopy(tabId);
      if (typeof page !== "object") {
        reportBlockedPage(page);
        return;
      }
      void spawnWorkspaceWindowWithPage(page)
        .then(() => toast.success(t("windowCopySentToNew")))
        .catch((error) => {
          console.error("[terax] temporary Workspace launch failed:", error);
          toast.error(t("windowCopyFailed"));
        });
    },
    [pageForCopy, reportBlockedPage, t],
  );

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let unlisten: UnlistenFn | null = null;
    void onWorkspaceRuntimeChange(async () => {
      const messages = await takeWorkspaceRuntimeMessages();
      if (messages.length === 0) return;
      const window = getCurrentWindow();
      await window.show().catch(() => {});
      await window.setFocus().catch(() => {});

      for (const message of messages) {
        if (message.kind === "activate") continue;
        if (message.kind === "openFiles") {
          await openFiles(
            message.files.map((file) => file.replace(/\\/g, "/")),
          );
          continue;
        }
        try {
          await openPage(message.page);
          toast.success(t("windowCopyReceived"));
        } catch (error) {
          console.error("[terax] copied Workspace page could not open:", error);
          toast.error(t("windowCopyReceiveFailed"));
        }
      }
    }, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) next();
        else unlisten = next;
      })
      .catch((error) => {
        console.error("[terax] Workspace runtime listener failed:", error);
      });
    return () => {
      controller.abort();
      unlisten?.();
    };
  }, [openFiles, openPage, ready, t]);

  return useMemo(
    () =>
      primary
        ? {
            enabled: windowMode === "multiple",
            targets,
            refreshTargets,
            copyToWindow,
            copyToNewWindow,
          }
        : undefined,
    [
      copyToNewWindow,
      copyToWindow,
      primary,
      refreshTargets,
      targets,
      windowMode,
    ],
  );
}
