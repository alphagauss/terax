/**
 * 活动栏与标签导航共用选中底块，只管理展示，不改变选择语义或滚动位置。
 * 宿主提供相对定位容器，目标以 data-navigation-indicator-target 标记，支持自身 aria-selected 或祖先 aria-pressed。
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { RevealMotion } from "@/lib/revealMotion";

/** 取消选中时淡出，连续切换接续当前画面；布局变化和隐藏恢复直接定位。 */
export function useNavigationIndicator(
  activeId: string | null,
  layoutKey: string,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const motion = useRef<RevealMotion | null>(null);
  const previous = useRef<{
    activeId: string | null;
    layoutKey: string;
  } | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const indicator = indicatorRef.current;
    if (!host || !indicator) return;
    const before = previous.current;
    const style = getComputedStyle(indicator);
    const from = {
      transform: style.transform === "none" ? "" : style.transform,
      opacity: style.opacity || "0",
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
    };
    const continuing = before?.activeId != null || motion.current !== null;
    motion.current?.finish(false);
    motion.current = null;
    const animate =
      continuing && before?.layoutKey === layoutKey && !document.hidden;
    previous.current = { activeId, layoutKey };
    const surface = host.querySelector<HTMLElement>(
      '[data-navigation-indicator-target][aria-selected="true"], [aria-pressed="true"] [data-navigation-indicator-target]',
    );

    if (!surface) {
      indicator.style.transform = from.transform || "none";
      indicator.style.opacity = "0";
      const hide = () => {
        indicator.style.visibility = "hidden";
        motion.current = null;
      };
      if (animate && Number(from.opacity) > 0) {
        const next = new RevealMotion(hide);
        motion.current = next;
        next.animate(indicator, [{ opacity: from.opacity }, { opacity: 0 }]);
        next.start();
      } else hide();
      return;
    }

    let geometry = "";
    const place = (transition: boolean) => {
      const width = surface.offsetWidth;
      const height = surface.offsetHeight;
      if (!width || !height) {
        motion.current?.finish();
        geometry = "";
        indicator.style.visibility = "hidden";
        previous.current = null;
        return;
      }
      // 累加定位祖先的布局坐标，避免在 zoom-content 内重复应用 UI 缩放。
      let left = 0;
      let top = 0;
      for (
        let item: HTMLElement | null = surface;
        item && item !== host;
        item = item.offsetParent as HTMLElement | null
      ) {
        left += item.offsetLeft;
        top += item.offsetTop;
      }
      const transform = `translate(${left}px, ${top}px)`;
      const nextGeometry = `${transform}:${width}:${height}`;
      if (!transition && geometry === nextGeometry) return;
      geometry = nextGeometry;
      motion.current?.finish(false);
      motion.current = null;
      indicator.style.width = `${width}px`;
      indicator.style.height = `${height}px`;
      indicator.style.transform = transform;
      indicator.style.opacity = "1";
      indicator.style.visibility = "visible";
      previous.current = { activeId, layoutKey };
      if (transition) {
        const next = new RevealMotion(() => {
          motion.current = null;
        });
        motion.current = next;
        // 仅缩放独立底块，变宽的文字标签与图标始终保持原尺寸。
        const frames: Keyframe[] = [
          {
            transform: `${from.transform} scale(${from.width / width}, ${from.height / height})`,
          },
          { transform },
        ];
        // 普通切换仅位移；只有打断退出时才接续未完成的透明度。
        if (Number(from.opacity) < 1) {
          frames[0].opacity = from.opacity;
          frames[1].opacity = 1;
        }
        next.animate(indicator, frames);
        next.start();
      }
    };
    place(animate && before?.activeId !== activeId);
    const observer = new ResizeObserver(() => place(false));
    observer.observe(host);
    for (const item of host.querySelectorAll(
      "[data-navigation-indicator-target]",
    ))
      observer.observe(item);
    return () => observer.disconnect();
  }, [activeId, layoutKey]);

  useEffect(() => {
    const stopWhenHidden = () => {
      if (!document.hidden) return;
      motion.current?.finish();
      previous.current = null;
    };
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", stopWhenHidden);
      motion.current?.finish(false);
    };
  }, []);

  return { hostRef, indicatorRef };
}
