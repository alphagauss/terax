/**
 * 本文件把 Tauri 文件拖放事件路由到鼠标下方的终端。
 * DOM 标记保存终端标签 ID，路径格式化后再写入对应输入流。
 */

import { nativeDropElementAt } from "@/lib/nativeFileDrop";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { useTerminalDropStore, type TerminalDropSurface } from "./dropStore";
import { terminalFilePaths } from "@/modules/terminal/lib/terminalClipboard";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { pasteIntoTerminal } from "./rendererPool";

/** 根据原生拖放位置查找对应终端，其他接收区不处理。 */
function terminalTargetAt(
  x: number,
  y: number,
): { id: number; surface: TerminalDropSurface } | null {
  const el = nativeDropElementAt(x, y);
  const terminal = el?.closest<HTMLElement>("[data-terminal-id]");
  if (!terminal) return null;
  const id = Number(terminal.dataset.terminalId);
  return Number.isFinite(id)
    ? {
        id,
        surface:
          terminal.dataset.terminalDropSurface === "input" ? "input" : "pane",
      }
    : null;
}

/** 只有本机终端展示接收边框；远端命中时提示拒绝，离开终端不处理。 */
export function useTerminalFileDrop(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const setTarget = useTerminalDropStore.getState().setTarget;

    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (disposed) return;
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") {
          const target =
            currentWorkspaceEnv().kind === "local"
              ? terminalTargetAt(p.position.x, p.position.y)
              : null;
          setTarget(target?.id ?? null, target?.surface);
          return;
        }
        if (p.type === "leave") {
          setTarget(null);
          return;
        }
        if (p.type === "drop") {
          setTarget(null);
          if (!p.paths.length) return;
          const target = terminalTargetAt(p.position.x, p.position.y);
          if (target !== null) {
            const text = terminalFilePaths(p.paths);
            if (text) pasteIntoTerminal(target.id, text);
          }
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => console.error("[terax] drag-drop listen failed:", err));

    return () => {
      disposed = true;
      setTarget(null);
      unlisten?.();
    };
  }, []);
}
