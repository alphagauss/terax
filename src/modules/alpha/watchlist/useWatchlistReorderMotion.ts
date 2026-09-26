/** 拖动提交后仅对可见行做位移归位；虚拟列表先提交最终位置，不逐帧更新业务或布局。 */
import { readMotionDurationMs, readMotionEasing } from "@/lib/motion";
import type { WatchlistItem } from "@/modules/alpha/watchlist/api";
import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

type RowPosition = { element: HTMLElement; offset: number };

function visiblePositions(host: HTMLElement) {
  const bounds = host.getBoundingClientRect();
  const positions = new Map<string, RowPosition>();
  for (const element of host.querySelectorAll<HTMLElement>(
    "[data-watchlist-position]",
  )) {
    const rect = element.getBoundingClientRect();
    const symbol = element.dataset.watchlistPosition;
    if (symbol && rect.bottom > bounds.top + 40 && rect.top < bounds.bottom)
      positions.set(symbol, {
        element,
        offset: Number(element.dataset.offset),
      });
  }
  return positions;
}

/** 只由本次拖动启用动画，失败、隐藏或后续交互会清理待播放状态。 */
export function useWatchlistReorderMotion({
  viewport,
  rows,
  enabled,
  locked,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  rows: WatchlistItem[];
  enabled: boolean;
  locked: boolean;
}) {
  const pending = useRef<{
    order: string;
    symbol: string;
    positions: Map<string, RowPosition>;
  } | null>(null);
  const animations = useRef(new Map<Animation, () => void>());
  const order = JSON.stringify(rows.map((row) => row.vt_symbol));
  const renderedOrder = useRef(order);
  const cancel = useCallback(() => {
    pending.current = null;
    for (const [animation, cleanup] of animations.current) {
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
      cleanup();
    }
    animations.current.clear();
  }, []);

  useLayoutEffect(() => {
    const orderChanged = renderedOrder.current !== order;
    renderedOrder.current = order;
    const host = viewport.current;
    if (!enabled || !host) {
      cancel();
      return;
    }
    const previous = pending.current;
    if (!previous) {
      if (orderChanged) cancel();
      return;
    }
    if (previous.order === order) {
      if (!locked) pending.current = null;
      return;
    }
    pending.current = null;
    const duration = readMotionDurationMs("--dur-surface", 240);
    if (duration <= 0) return;
    const easing = readMotionEasing(
      "--ease-emphasized",
      "cubic-bezier(0.16, 1, 0.3, 1)",
    );
    const next = visiblePositions(host);
    for (const [symbol, { element, offset }] of next) {
      const before = previous.positions.get(symbol);
      if (!before || before.element !== element || !element.animate) continue;
      // 长距离拖动只在当前视口内表达位移，不让整行穿越大量离屏内容。
      const delta = Math.max(
        -host.clientHeight,
        Math.min(host.clientHeight, before.offset - offset),
      );
      if (!delta) continue;
      const zIndex = element.style.zIndex;
      element.style.zIndex = symbol === previous.symbol ? "2" : "1";
      const animation = element.animate(
        [
          { transform: `translateY(${offset + delta}px)` },
          { transform: `translateY(${offset}px)` },
        ],
        { duration, easing },
      );
      const cleanup = () => {
        element.style.zIndex = zIndex;
        animations.current.delete(animation);
      };
      animations.current.set(animation, cleanup);
      animation.onfinish = cleanup;
      animation.oncancel = cleanup;
    }
  }, [order, locked, enabled, viewport, cancel]);

  useLayoutEffect(() => cancel, [cancel]);

  return {
    cancel,
    prepare(symbol: string) {
      cancel();
      const host = viewport.current;
      if (host && enabled && readMotionDurationMs("--dur-surface", 240) > 0)
        pending.current = { order, symbol, positions: visiblePositions(host) };
    },
  };
}
