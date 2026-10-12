/**
 * 本文件处理操作系统文件向 Explorer 的拖放与粘贴导入。
 * Local 工作区直接复制，WSL 与 SSH 固定创建 Direct 后台上传任务。
 */

import { readClipboardFiles } from "@/modules/file-actions/clipboard";
import { nativeDropElementAt } from "@/lib/nativeFileDrop";
import { formatTransferError } from "@/modules/transfers/errors";
import { transferNative } from "@/modules/transfers/native";
import { requestTransferPanel } from "@/modules/transfers/store";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { reportError } from "@/lib/errors";
import { parentDirectory } from "@/modules/filesystem";

type Options = {
  rootPath: string | null;
  isDir: (path: string) => boolean | undefined;
  onCopied: (destDir: string) => void;
};

/**
 * 解析外部拖放位置对应的目标目录。
 *
 * 原生物理坐标统一转换为 DOM 坐标。
 * `isDir` 返回 `undefined` 的删除中条目不可接收拖放。
 */
function dirAt(
  x: number,
  y: number,
  rootPath: string | null,
  isDir: (p: string) => boolean | undefined,
): string | null {
  const el = nativeDropElementAt(x, y);
  if (!el) return null;
  const row = el.closest<HTMLElement>("[data-fs-path]");
  if (row) {
    const p = row.getAttribute("data-fs-path") as string;
    const kind = isDir(p);
    if (kind === undefined) return null;
    return kind ? p : parentDirectory(p);
  }
  if (el.closest("[data-explorer-drop]")) return rootPath;
  return null;
}

/**
 * 接收拖放或粘贴到 Explorer 目录的宿主机路径。
 * Local 工作区直接复制，WSL 与 SSH 工作区只负责创建 Direct 后台传输任务。
 */
export function useExplorerFileDrop({ rootPath, isDir, onCopied }: Options) {
  const { t } = useTranslation(["explorer", "statusbar"]);
  const [targetDir, setTargetDir] = useState<string | null>(null);
  const optsRef = useRef({ rootPath, isDir, onCopied });
  optsRef.current = { rootPath, isDir, onCopied };

  const pasting = useRef(false);

  /** 系统拖放和粘贴共用导入规则；目的目录由触发操作时的选区或落点冻结。 */
  const importFiles = useCallback(
    async (paths: string[], destination: string) => {
      if (!paths.length) return;
      const sources = [...new Set(paths)];
      const workspace = currentWorkspaceEnv();
      const onCopied = optsRef.current.onCopied;
      if (workspace.kind !== "local") {
        try {
          const task = await transferNative.enqueue({
            direction: "upload",
            strategy: "direct",
            sources,
            destination,
          });
          requestTransferPanel(task.id);
          toast.success(t("menu.transferQueued"));
        } catch (error) {
          reportError(
            t("menu.transferFailed", { error: formatTransferError(error, t) }),
            { error },
          );
        }
        return;
      }
      try {
        await invoke("fs_copy", { sources, destDir: destination, workspace });
      } catch (error) {
        reportError(t("menu.copyFailed", { error: String(error) }), { error });
      } finally {
        // 多文件复制可能部分成功，失败后也刷新实际目录。
        onCopied(destination);
      }
    },
    [t],
  );

  const pasteFiles = async (destination: string) => {
    if (pasting.current) return;
    pasting.current = true;
    try {
      const paths = await readClipboardFiles();
      if (!paths.length) {
        toast.info(t("menu.noClipboardFiles"));
        return;
      }
      await importFiles(paths, destination);
    } catch (error) {
      reportError(t("menu.pasteFailed", { error: String(error) }), { error });
    } finally {
      pasting.current = false;
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (disposed) return;
        const { rootPath, isDir } = optsRef.current;
        if (p.type === "enter" || p.type === "over") {
          setTargetDir(dirAt(p.position.x, p.position.y, rootPath, isDir));
          return;
        }
        if (p.type === "leave") {
          setTargetDir(null);
          return;
        }
        if (p.type === "drop") {
          const dir = dirAt(p.position.x, p.position.y, rootPath, isDir);
          setTargetDir(null);
          if (!dir || p.paths.length === 0) return;
          void importFiles(p.paths, dir);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) =>
        console.error("[terax] explorer drop listen failed:", err),
      );

    return () => {
      disposed = true;
      setTargetDir(null);
      unlisten?.();
    };
  }, [importFiles]);

  return { externalTargetDir: targetDir, pasteFiles };
}
