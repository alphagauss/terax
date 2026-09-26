// @vitest-environment happy-dom

import type { WatchlistItem } from "@/modules/alpha/watchlist/api";
import { useWatchlistReorderMotion } from "@/modules/alpha/watchlist/useWatchlistReorderMotion";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const motion = vi.hoisted(() => ({ duration: 240 }));
vi.mock("@/lib/motion", () => ({
  readMotionDurationMs: () => motion.duration,
  readMotionEasing: () => "ease-out",
}));

it("只为拖动后的可见行归位，失败不残留动画，隐藏和减少动态效果会清理或跳过", () => {
  const container = document.createElement("div");
  const host = document.createElement("div");
  const viewport = { current: host };
  host.getBoundingClientRect = () => new DOMRect(0, 0, 320, 300);
  Object.defineProperty(host, "clientHeight", { value: 300 });
  const animations: Array<{
    cancel: ReturnType<typeof vi.fn>;
    onfinish: (() => void) | null;
    oncancel: (() => void) | null;
  }> = [];
  const animate = vi.fn(() => {
    const animation = { cancel: vi.fn(), onfinish: null, oncancel: null };
    animations.push(animation);
    return animation as unknown as Animation;
  });
  const header = document.createElement("div");
  const animateHeader = vi.fn();
  header.animate = animateHeader;
  host.append(header);
  const items = ["A", "B", "C"].map(
    (vt_symbol, position): WatchlistItem => ({
      vt_symbol,
      position,
      name: vt_symbol,
      group_id: "all",
      pinned: false,
      pin_position: 0,
      price_tick: 0.01,
    }),
  );
  const elements = new Map(
    items.map((item, index) => {
      const element = document.createElement("div");
      element.dataset.watchlistPosition = item.vt_symbol;
      element.dataset.offset = String(index * 52);
      element.getBoundingClientRect = () =>
        new DOMRect(0, 40 + Number(element.dataset.offset), 320, 52);
      element.animate = animate;
      host.append(element);
      return [item.vt_symbol, element] as const;
    }),
  );
  let controls: ReturnType<typeof useWatchlistReorderMotion> | undefined;
  function Harness({
    rows,
    enabled,
    locked,
  }: {
    rows: WatchlistItem[];
    enabled: boolean;
    locked: boolean;
  }) {
    controls = useWatchlistReorderMotion({ viewport, rows, enabled, locked });
    return null;
  }
  const root = createRoot(container);
  const render = (rows: WatchlistItem[], locked = false, enabled = true) => {
    rows.forEach((row, index) => {
      const element = elements.get(row.vt_symbol);
      if (element) element.dataset.offset = String(index * 52);
    });
    act(() =>
      root.render(<Harness rows={rows} locked={locked} enabled={enabled} />),
    );
  };
  const reordered = [items[0], items[2], items[1]];
  try {
    render(items);
    controls?.prepare("B");
    render(items, true);
    render(reordered);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animateHeader).not.toHaveBeenCalled();
    expect(animate).toHaveBeenCalledWith(
      [{ transform: "translateY(52px)" }, { transform: "translateY(104px)" }],
      { duration: 240, easing: "ease-out" },
    );
    expect(elements.get("B")?.style.zIndex).toBe("2");
    render(reordered, false, false);
    expect(
      animations.every((animation) => animation.cancel.mock.calls.length === 1),
    ).toBe(true);
    expect(elements.get("B")?.style.zIndex).toBe("");

    animate.mockClear();
    render(items);
    controls?.prepare("B");
    render(items, true);
    render(items);
    // 失败后随后到达的其他窗口排序不能触发本次拖动动画。
    render(reordered);
    expect(animate).not.toHaveBeenCalled();

    motion.duration = 0;
    controls?.prepare("B");
    render(reordered, true);
    render(items);
    expect(animate).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    motion.duration = 240;
  }
});
