/** 页内浮窗的标题栏拖动；位置归展示实例所有，不触发内容重渲染或业务重建。 */
import {
  useCallback,
  useLayoutEffect,
  useRef,
  type PointerEvent,
  type RefObject,
} from "react";

/** 使用宿主坐标限制浮窗位置，宿主缩小时重新收拢；隐藏和失去捕获均结束拖动。 */
export function useBoundedDrag(
  panelRef: RefObject<HTMLDivElement | null>,
  host: HTMLElement | null,
  enabled: boolean,
  active: boolean,
) {
  const offset = useRef({ x: 0, y: 0 });
  const session = useRef<{
    pointerId: number;
    handle: HTMLElement;
    x: number;
    y: number;
  } | null>(null);

  const finish = useCallback(() => {
    const drag = session.current;
    session.current = null;
    if (!drag) return;
    if (drag.handle.hasPointerCapture(drag.pointerId))
      drag.handle.releasePointerCapture(drag.pointerId);
  }, []);

  const move = useCallback(
    (dx: number, dy: number) => {
      const panel = panelRef.current;
      if (!panel || !host) return;
      const bounds = host.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const rect = panel.getBoundingClientRect();
      // 保持整个窗口在宿主内；极小宿主中优先保证标题和关闭按钮可达。
      const left = Math.max(
        bounds.left,
        Math.min(rect.left + dx, bounds.right - rect.width),
      );
      const top = Math.max(
        bounds.top,
        Math.min(rect.top + dy, bounds.bottom - rect.height),
      );
      offset.current.x += left - rect.left;
      offset.current.y += top - rect.top;
      panel.style.transform = `translate3d(${offset.current.x}px, ${offset.current.y}px, 0)`;
    },
    [host, panelRef],
  );

  useLayoutEffect(() => {
    if (!enabled || !active || !host) return;
    const observer = new ResizeObserver(() => move(0, 0));
    observer.observe(host);
    if (panelRef.current) observer.observe(panelRef.current);
    return () => {
      observer.disconnect();
      finish();
    };
  }, [enabled, active, host, panelRef, move, finish]);

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (
        !enabled ||
        !active ||
        session.current ||
        event.button !== 0 ||
        event.ctrlKey
      )
        return;
      if (
        (event.target as HTMLElement).closest(
          "button, a, input, select, textarea, [role=button], [contenteditable=true]",
        )
      )
        return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      session.current = {
        pointerId: event.pointerId,
        handle: event.currentTarget,
        x: event.clientX,
        y: event.clientY,
      };
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const drag = session.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      move(event.clientX - drag.x, event.clientY - drag.y);
      drag.x = event.clientX;
      drag.y = event.clientY;
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      if (session.current?.pointerId === event.pointerId) finish();
    },
    onPointerCancel(event: PointerEvent<HTMLElement>) {
      if (session.current?.pointerId === event.pointerId) finish();
    },
    onLostPointerCapture(event: PointerEvent<HTMLElement>) {
      if (session.current?.pointerId === event.pointerId) finish();
    },
  };
}
