/** 自选内部排序使用指针捕获，避开 Windows WebView 原生文件拖放对 HTML5 拖放的接管。 */

import type {
  WatchlistCommand,
  WatchlistItem,
} from "@/modules/alpha/watchlist/api";
import { type PointerEvent, useCallback, useEffect, useRef } from "react";

export function useWatchlistDrag({
  enabled,
  rows,
  onFreeze,
  onCommand,
}: {
  enabled: boolean;
  rows: WatchlistItem[];
  onFreeze: (symbols: string[] | null) => void;
  onCommand: (command: WatchlistCommand) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const options = useRef({ enabled, rows, onFreeze, onCommand });
  options.current = { enabled, rows, onFreeze, onCommand };
  const session = useRef<{
    item: WatchlistItem;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    active: boolean;
    target: { anchor: string; side: "before" | "after" } | null;
  } | null>(null);
  const marker = useRef<HTMLDivElement | null>(null);
  const frame = useRef<number | null>(null);
  const suppressClick = useRef(false);

  const locate = useCallback(() => {
    const drag = session.current;
    const host = viewport.current;
    if (!drag || !host) return;
    const bounds = host.getBoundingClientRect();
    const element = host.ownerDocument
      .elementFromPoint(drag.x, drag.y)
      ?.closest<HTMLElement>("[data-watchlist-symbol]");
    const row = options.current.rows.find(
      (item) => item.vt_symbol === element?.dataset.watchlistSymbol,
    );
    drag.target = null;
    if (
      !element ||
      !host.contains(element) ||
      !row ||
      row.vt_symbol === drag.item.vt_symbol ||
      row.pinned !== drag.item.pinned ||
      drag.y < bounds.top + 40 ||
      drag.y > bounds.bottom ||
      drag.x < bounds.left ||
      drag.x > bounds.right
    ) {
      marker.current?.remove();
      return;
    }
    const rect = element.getBoundingClientRect();
    const side = drag.y < rect.top + rect.height / 2 ? "before" : "after";
    drag.target = { anchor: row.vt_symbol, side };
    const line = marker.current ?? host.ownerDocument.createElement("div");
    line.className = `pointer-events-none absolute inset-x-0 z-20 h-px bg-primary ${side === "before" ? "top-0" : "bottom-0"}`;
    if (line.parentElement !== element) element.appendChild(line);
    marker.current = line;
  }, []);

  const scroll = useCallback(
    function tick() {
      const drag = session.current;
      const host = viewport.current;
      if (!drag?.active || !host) return;
      const bounds = host.getBoundingClientRect();
      if (
        drag.x >= bounds.left &&
        drag.x <= bounds.right &&
        drag.y >= bounds.top &&
        drag.y <= bounds.bottom
      ) {
        const previous = host.scrollTop;
        if (drag.y < bounds.top + 68) host.scrollTop -= 10;
        else if (drag.y > bounds.bottom - 28) host.scrollTop += 10;
        if (host.scrollTop !== previous) locate();
      }
      frame.current = requestAnimationFrame(tick);
    },
    [locate],
  );

  const finish = useCallback((commit: boolean) => {
    const drag = session.current;
    session.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    marker.current?.remove();
    marker.current = null;
    const host = viewport.current;
    if (host) {
      host.style.cursor = "";
      delete host.dataset.watchlistDragging;
      if (drag && host.hasPointerCapture(drag.pointerId))
        host.releasePointerCapture(drag.pointerId);
    }
    if (!drag?.active) return;
    suppressClick.current = true;
    options.current.onFreeze(null);
    if (commit && drag.target && options.current.enabled)
      options.current.onCommand({
        action: "reorder",
        group_id: drag.item.group_id,
        symbols: [drag.item.vt_symbol],
        ...drag.target,
      });
  }, []);

  useEffect(() => {
    if (!enabled) {
      finish(false);
      return;
    }
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(false);
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
      finish(false);
    };
  }, [enabled, finish]);

  return {
    viewport,
    start(event: PointerEvent, item: WatchlistItem) {
      suppressClick.current = false;
      if (
        !options.current.enabled ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.pointerType === "touch"
      )
        return;
      session.current = {
        item,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        target: null,
      };
    },
    onPointerMove(event: PointerEvent) {
      const drag = session.current;
      const host = viewport.current;
      if (!drag || drag.pointerId !== event.pointerId || !host) return;
      if (event.buttons === 0) {
        finish(false);
        return;
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (!drag.active) {
        if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
        drag.active = true;
        host.setPointerCapture(event.pointerId);
        host.style.cursor = "grabbing";
        host.dataset.watchlistDragging = "true";
        options.current.onFreeze(
          options.current.rows.map((item) => item.vt_symbol),
        );
        frame.current = requestAnimationFrame(scroll);
      }
      event.preventDefault();
      locate();
    },
    onPointerUp(event: PointerEvent) {
      if (session.current?.pointerId !== event.pointerId) return;
      if (session.current.active) {
        session.current.x = event.clientX;
        session.current.y = event.clientY;
        locate();
      }
      finish(true);
    },
    onPointerCancel() {
      finish(false);
    },
    onLostPointerCapture() {
      finish(false);
    },
    onClickCapture(event: {
      preventDefault: () => void;
      stopPropagation: () => void;
    }) {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
