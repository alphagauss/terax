/**
 * 本文件管理按键驱动的标签切换浮层。
 * 候选顺序由调用方决定，松开修饰键后提交选中标签。
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type TabSwitcherState = {
  order: number[];
  index: number;
  initialId: number;
};

type Options = {
  /** 按切换浮层展示顺序返回候选标签 ID。 */
  getOrder: () => number[];
  /** 返回本次切换开始时的活动标签 ID。 */
  getActiveId: () => number;
  /** 确认后接收新选中的标签 ID，不会传入原活动标签。 */
  onCommit: (id: number) => void;
};

/** 根据显示顺序计算下一个切换状态，首次从当前标签的真实位置起步。 */
export function advanceTabSwitcher(
  previous: TabSwitcherState | null,
  delta: 1 | -1,
  order: number[],
  activeId: number,
): TabSwitcherState | null {
  if (previous) {
    const len = previous.order.length;
    return {
      ...previous,
      index: (previous.index + delta + len) % len,
    };
  }
  if (order.length < 2) return null;
  const initialIndex = order.indexOf(activeId);
  if (initialIndex < 0) return null;
  return {
    order,
    index: (initialIndex + delta + order.length) % order.length,
    initialId: activeId,
  };
}

/** 在修饰键持续按住期间循环候选标签，并在松开后提交。 */
export function useTabSwitcher({ getOrder, getActiveId, onCommit }: Options) {
  const [state, setState] = useState<TabSwitcherState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const cb = useRef({ getOrder, getActiveId, onCommit });
  cb.current = { getOrder, getActiveId, onCommit };

  const step = useCallback((delta: 1 | -1) => {
    setState((prev) => {
      if (prev)
        return advanceTabSwitcher(prev, delta, prev.order, prev.initialId);
      const order = cb.current.getOrder();
      const initialId = cb.current.getActiveId();
      return advanceTabSwitcher(null, delta, order, initialId);
    });
  }, []);

  const commit = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    setState(null);
    const id = s.order[s.index];
    if (id !== undefined && id !== s.initialId) cb.current.onCommit(id);
  }, []);

  const cancel = useCallback(() => setState(null), []);

  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (!stateRef.current) return;
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) commit();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (stateRef.current && e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("blur", cancel);
    };
  }, [commit, cancel]);

  return { state, step, cancel };
}
