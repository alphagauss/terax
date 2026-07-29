/**
 * 本文件渲染文本选区旁的 AI 快捷操作浮窗。
 * 浮窗跟随鼠标释放位置，并保持在视口内，不参与选区内容捕获。
 */

import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import type { PresenceState } from "@/lib/usePresence";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export type SelectionAskAiProps = {
  state: PresenceState;
  x: number;
  y: number;
  onAsk: () => void;
  onDismiss: () => void;
};

const W = 110;
const OFFSET = 40;

/**
 * 文本选区的 AI 快捷操作浮窗。
 *
 * 支持点击和键盘提示，并阻止浮窗自身触发浏览器原生右键菜单。
 */
export function SelectionAskAi({
  state,
  x,
  y,
  onAsk,
  onDismiss,
}: SelectionAskAiProps) {
  const { t } = useTranslation("ai");
  const pos = useRef({ top: 0, left: 0 });
  const open = state === "open";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  if (open) {
    pos.current = {
      top: Math.max(8, y - OFFSET),
      left: Math.max(8, Math.min(x - W / 2, window.innerWidth - W - 8)),
    };
  }

  return (
    <div
      data-selection-ask-ai
      data-state={state}
      style={{ top: pos.current.top, left: pos.current.left, width: W }}
      className="fixed z-50 duration-control ease-standard data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-1"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAsk();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        className="flex h-7 w-full items-center justify-between gap-1.5 whitespace-nowrap rounded-md border border-border/60 bg-card/95 px-2 text-xs shadow-lg backdrop-blur-md hover:border-border hover:bg-accent"
      >
        <span className="shrink-0">{t("selectionAsk")}</span>
        <KbdGroup>
          <Kbd className="h-4 min-w-4 px-1 text-[10px]">
            {fmtShortcut(MOD_KEY, "L")}
          </Kbd>
        </KbdGroup>
      </button>
    </div>
  );
}
