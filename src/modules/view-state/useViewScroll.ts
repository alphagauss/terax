/** 按稳定条目身份恢复阅读位置；列表插入、删除或后台校验不强制回到顶部。 */

import { type RefObject, useLayoutEffect, useRef, useCallback } from "react";
import { useViewMemory, useViewScopeKey } from "./ViewState";

type Position = { key?: string; index: number; offset: number; top: number };

/** 普通列表标记 data-view-row，虚拟列表提供行高；空列表不覆盖尚待恢复的锚点。 */
export function useViewScroll(
  slot: string,
  elementRef: RefObject<HTMLElement | null>,
  keys: readonly string[],
  active: boolean,
  rowHeight?: number,
) {
  const scope = `${useViewScopeKey()}\0${slot}`;
  const memory = useViewMemory<Position>(`scroll:${slot}`);
  const position = useRef<{ scope: string; value?: Position } | null>(null);
  if (position.current?.scope !== scope)
    position.current = { scope, value: memory.read() };
  const installRef = useRef<
    (element: HTMLElement | null) => (() => void) | undefined
  >(() => undefined);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  installRef.current = (element) => {
    if (!element || !active || !keys.length) return;
    const rows = () => [
      ...element.querySelectorAll<HTMLElement>("[data-view-row]"),
    ];
    const saved = position.current?.value;
    if (saved && saved.top > 0) {
      const index = Math.max(
        0,
        Math.min(
          keys.length - 1,
          saved.key && keys.includes(saved.key)
            ? keys.indexOf(saved.key)
            : saved.index,
        ),
      );
      const row = rowHeight
        ? null
        : rows().find((row) => row.dataset.viewRow === keys[index]);
      element.scrollTop = rowHeight
        ? index * rowHeight + saved.offset
        : row
          ? row.getBoundingClientRect().top -
            element.getBoundingClientRect().top +
            element.scrollTop +
            saved.offset
          : saved.top;
    } else element.scrollTop = 0;
    const save = () => {
      const top = element.scrollTop;
      let index = rowHeight ? Math.floor(top / rowHeight) : 0;
      let offset = rowHeight ? top % rowHeight : top;
      if (!rowHeight) {
        const boundary = element.getBoundingClientRect().top;
        const row = rows().find(
          (row) => row.getBoundingClientRect().bottom > boundary,
        );
        if (row) {
          index = keys.indexOf(row.dataset.viewRow ?? "");
          offset = boundary - row.getBoundingClientRect().top;
        }
      }
      const value = {
        key: keys[index],
        index: Math.max(0, index),
        offset,
        top,
      };
      position.current = { scope, value };
      memory.write(value);
    };
    element.addEventListener("scroll", save);
    return () => element.removeEventListener("scroll", save);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: 列表与作用域变化时重新应用锚点，安装逻辑读取当前 render 的 ref。
  useLayoutEffect(() => {
    cleanup.current?.();
    cleanup.current = installRef.current(elementRef.current);
    return () => {
      cleanup.current?.();
      cleanup.current = undefined;
    };
  }, [elementRef, keys, active, rowHeight, memory.write]);
  return useCallback(
    (element: HTMLElement | null) => {
      elementRef.current = element;
      cleanup.current?.();
      cleanup.current = installRef.current(element);
    },
    [elementRef],
  );
}
