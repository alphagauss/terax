import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { useTerminalDropStore } from "./dropStore";
import { formatDroppedPaths } from "./quoteShellPath";
import { pasteIntoLeaf } from "./rendererPool";

// Tauri reports the drop point in physical pixels on some platforms and logical
// on others; only scale down when it overflows the logical viewport.
function terminalIdAt(x: number, y: number): number | null {
  let lx = x;
  let ly = y;
  if (x > window.innerWidth || y > window.innerHeight) {
    const dpr = window.devicePixelRatio || 1;
    lx = x / dpr;
    ly = y / dpr;
  }
  const el = document.elementFromPoint(lx, ly);
  const terminal = el?.closest<HTMLElement>("[data-terminal-id]");
  if (!terminal) return null;
  const id = Number(terminal.dataset.terminalId);
  return Number.isFinite(id) ? id : null;
}

/** Wires native OS file drops into the terminal under the cursor: shows a drop
 * overlay while dragging and bracketed-pastes the shell-quoted paths on drop.
 * Drops outside a terminal are ignored. */
export function useTerminalFileDrop(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const setTarget = useTerminalDropStore.getState().setTarget;

    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") {
          setTarget(terminalIdAt(p.position.x, p.position.y));
          return;
        }
        if (p.type === "leave") {
          setTarget(null);
          return;
        }
        if (p.type === "drop") {
          setTarget(null);
          if (!p.paths.length) return;
          const terminalId = terminalIdAt(p.position.x, p.position.y);
          if (terminalId !== null) {
            pasteIntoLeaf(terminalId, formatDroppedPaths(p.paths));
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
