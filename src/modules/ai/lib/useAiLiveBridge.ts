/**
 * 本文件把当前 Workbench 的实时上下文、默认草稿目录和导航能力桥接到 AI 会话。
 * 默认目录在 AI 可见时准备，用于草稿目录切换；历史目录导航仍复用现有标签。
 */

import {
  currentWorkspaceEnv,
  prepareDefaultWorkspaceRoot,
} from "@/modules/workspace";
import type { TerminalPaneHandle } from "@/modules/terminal";
import type { Tab } from "@/modules/workbench";
import { invoke } from "@tauri-apps/api/core";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { reportError } from "@/lib/errors";
import type { Live } from "../store/chatStore";
import { native } from "./native";
import { redactSensitive } from "./redact";
import { resolveWorkingDirectoryTarget } from "./workingDirectoryNavigation";

type Params = {
  openFileReference?: Live["openFileReference"];
  openFileEdits?: Live["openFileEdits"];
  setLive: (live: Live) => void;
  activeId: number;
  activeSpaceId: string | null;
  tabs: Tab[];
  explorerRoot: string | null;
  environmentHome: string | null;
  visible: boolean;
  setActiveId: (tabId: number) => void;
  newTab: (cwd?: string) => number;
  ensureWorkspaceReady: () => Promise<string | null>;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
};

/**
 * 将草稿 cwd、目录导航和终端缓冲区发布到聊天运行时。
 * Explorer 根优先于延迟创建的默认目录；终端 getter 通过 ref 读取最新状态。
 */
export function useAiLiveBridge(params: Params) {
  const { t } = useTranslation("ai");
  const { setLive, terminalRefs } = params;
  const [defaultRoot, setDefaultRoot] = useState<string | null>(null);
  const ref = useRef(params);
  ref.current = params;

  useEffect(() => {
    const waitingForSsh =
      currentWorkspaceEnv().kind === "ssh" && !params.environmentHome;
    if (!params.visible || defaultRoot || waitingForSsh) {
      return;
    }
    let active = true;
    void prepareDefaultWorkspaceRoot()
      .then((root) => {
        if (active) setDefaultRoot(root);
      })
      .catch((error) => {
        if (!active) return;
        console.error(
          "[terax] default AI workspace preparation failed:",
          error,
        );
        reportError(t("composer.workingDirectoryUnavailable"), {
          error,
        });
      });
    return () => {
      active = false;
    };
  }, [defaultRoot, params.environmentHome, params.visible, t]);

  useEffect(() => {
    setLive({
      openFileReference: (path, line) =>
        ref.current.openFileReference?.(path, line),
      openFileEdits: (input) => ref.current.openFileEdits?.(input),
      draftCwd: params.explorerRoot ?? defaultRoot,
      draftProjectRoot: params.explorerRoot,
      defaultDraftCwd: defaultRoot,
      revealWorkingDirectory: async (cwd: string) => {
        const decide = (path: string) => {
          const current = ref.current;
          return resolveWorkingDirectoryTarget(
            current.tabs,
            current.explorerRoot,
            path,
            currentWorkspaceEnv(),
            current.activeSpaceId,
          );
        };
        const applyExisting = (path: string) => {
          const target = decide(path);
          if (target.kind === "tab") {
            ref.current.setActiveId(target.tabId);
          }
          return target.kind !== "new-terminal";
        };

        if (applyExisting(cwd)) return;
        if (!(await ref.current.ensureWorkspaceReady())) return;
        if (applyExisting(cwd)) return;

        const workspace = currentWorkspaceEnv();
        const stat = await invoke<{ kind: string }>("fs_stat", {
          path: cwd,
          workspace,
        });
        if (stat.kind !== "dir") throw new Error("cwd is not a directory");
        const authorized = await native.workspaceAuthorize(cwd);
        const terminalCwd = workspace.kind === "wsl" ? cwd : authorized;

        if (applyExisting(cwd) || applyExisting(terminalCwd)) return;
        ref.current.newTab(terminalCwd);
      },
      getTerminalContext: (maxLines) => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return null;
        if (t.private) return null;
        const buf = terminalRefs.current.get(t.id)?.getBuffer(maxLines);
        return buf ? redactSensitive(buf) : null;
      },
      isActiveTerminalPrivate: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "terminal" && t.private === true;
      },
    });
  }, [defaultRoot, params.explorerRoot, setLive, terminalRefs]);
}
