/**
 * 本文件处理从操作系统拖放到 Explorer 的文件和文件夹。
 * Local 工作区继续直接复制，WSL 与 SSH 拖放固定创建 Direct 后台上传任务。
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatTransferError } from "@/modules/transfers/errors";
import { transferNative } from "@/modules/transfers/native";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { useTranslation } from "react-i18next";

type Options = {
  rootPath: string | null;
  isDir: (path: string) => boolean | undefined;
  onCopied: (destDir: string) => void;
};

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

// Tauri reports the drop point in physical pixels on some platforms; scale down
// only when it overflows the logical viewport (mirrors the terminal drop).
function dirAt(
  x: number,
  y: number,
  rootPath: string | null,
  isDir: (p: string) => boolean | undefined,
): string | null {
  let lx = x;
  let ly = y;
  if (x > window.innerWidth || y > window.innerHeight) {
    const dpr = window.devicePixelRatio || 1;
    lx = x / dpr;
    ly = y / dpr;
  }
  const el = document.elementFromPoint(lx, ly) as HTMLElement | null;
  if (!el) return null;
  const row = el.closest<HTMLElement>("[data-fs-path]");
  if (row) {
    const p = row.getAttribute("data-fs-path") as string;
    return isDir(p) ? p : parentDir(p);
  }
  if (el.closest("[data-explorer-drop]")) return rootPath;
  return null;
}

/**
 * 接收拖放到 Explorer 目录的宿主机路径。
 * Local 工作区直接复制，WSL 与 SSH 工作区只负责创建 Direct 后台传输任务。
 */
export function useExplorerFileDrop({ rootPath, isDir, onCopied }: Options) {
  const { t } = useTranslation(["explorer", "statusbar"]);
  const [targetDir, setTargetDir] = useState<string | null>(null);
  const optsRef = useRef({ rootPath, isDir, onCopied });
  optsRef.current = { rootPath, isDir, onCopied };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        const { rootPath, isDir, onCopied } = optsRef.current;
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
          const workspace = currentWorkspaceEnv();
          if (workspace.kind !== "local") {
            void transferNative
              .enqueueDirect({
                direction: "upload",
                sources: p.paths,
                destination: dir,
              })
              .then(() => toast.success(t("menu.transferQueued")))
              .catch((error) =>
                toast.error(
                  t("menu.transferFailed", {
                    error: formatTransferError(error, t),
                  }),
                ),
              );
            return;
          }
          void invoke("fs_copy", {
            sources: p.paths,
            destDir: dir,
            workspace,
          })
            .then(() => onCopied(dir))
            .catch((error) =>
              toast.error(t("menu.copyFailed", { error: String(error) })),
            );
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
  }, [t]);

  return { externalTargetDir: targetDir };
}
