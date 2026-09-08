/**
 * 分组真实尺寸一次提交，固定尺寸的裁剪外壳与内容反向移动完成视觉过渡。
 * 不缩放或复制内容，尺寸观测只在切换边界发生；再次切换从当前视觉位置接续。
 */
import { readMotionDurationMs, readMotionEasing } from "@/lib/motion";
import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

type Snapshot = {
  element: HTMLElement;
  top: number;
  height: number;
  contentHeight: number;
};

/** 仅服务侧边栏分组开关，拖动、容器尺寸变化和卸载会结束临时展示状态。 */
export function useSectionLayoutAnimation(
  groupRef: RefObject<HTMLDivElement | null>,
) {
  const pendingRef = useRef<Snapshot[] | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const finish = useCallback(() => {
    pendingRef.current = null;
    cleanupRef.current?.();
  }, []);

  const capture = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    const snapshots = Array.from(group.children, (child) => {
      const element = child as HTMLElement;
      const viewport = element.querySelector<HTMLElement>(
        "[data-section-viewport]",
      );
      const content = viewport?.firstElementChild as HTMLElement | null;
      const rect = (content ?? element).getBoundingClientRect();
      return {
        element,
        top: rect.top,
        height: viewport
          ? viewport.getBoundingClientRect().bottom - rect.top
          : rect.height,
        contentHeight: rect.height,
      };
    });
    finish();
    pendingRef.current = snapshots;
  }, [finish, groupRef]);

  useLayoutEffect(() => {
    const snapshots = pendingRef.current;
    pendingRef.current = null;
    if (!snapshots) return;
    const duration = readMotionDurationMs("--dur-pane", 150);
    if (duration <= 0) return;
    const options = {
      duration,
      easing: readMotionEasing("--ease-standard", "ease"),
      fill: "both" as const,
    };
    const animations: Animation[] = [];
    const viewports: HTMLElement[] = [];
    // 先批量测量最终布局，再设置临时外壳，避免读写交错强制布局。
    const targets = snapshots.map((snapshot) => ({
      ...snapshot,
      rect: snapshot.element.getBoundingClientRect(),
    }));
    for (const { element, top, height, contentHeight, rect } of targets) {
      const offset = top - rect.top;
      if (Math.abs(offset) < 0.5 && Math.abs(height - rect.height) < 0.5) {
        continue;
      }
      const viewport = element.querySelector<HTMLElement>(
        "[data-section-viewport]",
      );
      if (viewport) {
        const content = viewport.firstElementChild as HTMLElement;
        const fixedHeight = Math.max(contentHeight, rect.height);
        const from = fixedHeight - height;
        const to = fixedHeight - rect.height;
        viewport.style.height = `${fixedHeight}px`;
        viewports.push(viewport);
        animations.push(
          viewport.animate(
            [
              { transform: `translateY(${offset - from}px)` },
              { transform: `translateY(${-to}px)` },
            ],
            options,
          ),
          content.animate(
            [
              { transform: `translateY(${from}px)` },
              { transform: `translateY(${to}px)` },
            ],
            options,
          ),
        );
      } else {
        animations.push(
          element.animate(
            [
              { transform: `translateY(${offset}px)` },
              { transform: "translateY(0)" },
            ],
            options,
          ),
        );
      }
    }
    if (animations.length === 0) return;
    const cleanup = () => {
      for (const animation of animations) {
        animation.onfinish = null;
        animation.oncancel = null;
        animation.cancel();
      }
      for (const viewport of viewports) viewport.style.removeProperty("height");
      cleanupRef.current = null;
    };
    cleanupRef.current = cleanup;
    for (const animation of animations) animation.oncancel = cleanup;
    animations[0].onfinish = cleanup;
  });

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    let width = group.clientWidth;
    let height = group.clientHeight;
    const observer = new ResizeObserver(() => {
      if (group.clientWidth === width && group.clientHeight === height) return;
      width = group.clientWidth;
      height = group.clientHeight;
      finish();
    });
    const handleInteraction = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-slot="resizable-handle"]')
      ) {
        finish();
      }
    };
    observer.observe(group);
    group.addEventListener("pointerdown", handleInteraction, true);
    group.addEventListener("keydown", handleInteraction, true);
    return () => {
      observer.disconnect();
      group.removeEventListener("pointerdown", handleInteraction, true);
      group.removeEventListener("keydown", handleInteraction, true);
      finish();
    };
  }, [finish, groupRef]);

  return capture;
}
