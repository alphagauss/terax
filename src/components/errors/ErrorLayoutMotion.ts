/** 错误详情的局部布局动效：借鉴 Surf 的布局坐标缓存，只移动卡片并缩放独立背景。 */
import { RevealMotion } from "@/lib/revealMotion";

type Box = { top: number; height: number };

/** 错误宿主同步卡片集合，尺寸观察仅协调展示，不触发业务更新或逐帧布局。 */
export class ErrorLayoutMotion {
  private root: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private boxes = new Map<HTMLElement, Box>();
  private motion: RevealMotion | null = null;
  private width = 0;
  private height = 0;

  private measure() {
    const boxes = new Map<HTMLElement, Box>();
    for (const element of this.root?.children ?? []) {
      if (
        !(element instanceof HTMLElement) ||
        element.inert ||
        !element.getClientRects().length
      )
        continue;
      boxes.set(element, {
        top: element.offsetTop,
        height: element.offsetHeight,
      });
    }
    return boxes;
  }

  sync(root: HTMLElement | null, reset = false) {
    if (this.root !== root) {
      this.disconnect();
      this.root = root;
      if (root) {
        this.observer = new ResizeObserver(this.update);
        this.observer.observe(root);
        window.addEventListener("scroll", this.reset, true);
        window.addEventListener("resize", this.reset);
        document.addEventListener("visibilitychange", this.reset);
      }
      reset = true;
    }
    const next = this.measure();
    for (const element of this.boxes.keys())
      if (!next.has(element)) this.observer?.unobserve(element);
    for (const element of next.keys())
      if (!this.boxes.has(element))
        this.observer?.observe(element, { box: "border-box" });
    if (reset) this.reset();
    else
      this.boxes = new Map(
        [...next].map(([element, box]) => [
          element,
          this.boxes.get(element) ?? box,
        ]),
      );
  }

  stop() {
    this.motion?.finish(false);
    this.motion = null;
  }

  private reset = () => {
    this.stop();
    this.boxes = this.measure();
    this.width = this.root?.clientWidth ?? 0;
    this.height = this.root?.getBoundingClientRect().height ?? 0;
  };

  private update = () => {
    const root = this.root;
    if (!root) return;
    if (document.hidden || this.width !== root.clientWidth) {
      this.reset();
      return;
    }
    const next = this.measure();
    if (
      next.size === this.boxes.size &&
      [...next].every(([element, box]) => {
        const old = this.boxes.get(element);
        return old && old.top === box.top && old.height === box.height;
      })
    ) {
      if (!this.motion) this.height = root.getBoundingClientRect().height;
      return;
    }
    const viewport = root.getBoundingClientRect();
    const top = Math.max(0, viewport.top),
      bottom = Math.min(window.innerHeight, viewport.bottom);
    // offset 坐标不含旧动画；先补上当前视觉进度，再取消并接续本次过渡。
    const changes = [...next].flatMap(([element, box]) => {
      const old = this.boxes.get(element);
      if (!old) return [];
      const translate = window.getComputedStyle(element).translate || "0px 0px";
      const y = Number.parseFloat(translate.split(" ")[1] ?? "0") || 0;
      const surface = element.querySelector<HTMLElement>(
        "[data-error-surface]",
      );
      const scales = (
        surface ? window.getComputedStyle(surface).scale || "1" : "1"
      )
        .split(" ")
        .map(Number);
      const oldTop = viewport.top + old.top + y - root.scrollTop;
      const newTop = viewport.top + box.top - root.scrollTop;
      const visible =
        Math.min(oldTop, newTop) < bottom &&
        Math.max(oldTop + old.height, newTop + box.height) > top;
      const edge = top - Math.max(old.height, box.height);
      return visible
        ? [
            {
              element,
              surface,
              from: Math.max(edge, Math.min(bottom, oldTop)) - newTop,
              to: Math.max(edge, Math.min(bottom, newTop)) - newTop,
              scale: box.height
                ? (old.height * (scales[1] ?? scales[0])) / box.height
                : 1,
            },
          ]
        : [];
    });
    this.stop();
    this.boxes = next;
    const height = root.getBoundingClientRect().height;
    const motion = new RevealMotion(() => {
      this.motion = null;
    });
    this.motion = motion;
    // 收起时保留原可见底边，避免已提交的新高度提前裁掉退场内容。
    motion.style(root, "height", `${Math.max(this.height, height)}px`);
    this.height = height;
    for (const { element, surface, from, to, scale } of changes) {
      motion.move(element, from, to);
      if (surface && Number.isFinite(scale) && Math.abs(scale - 1) >= 0.001)
        motion.animate(surface, [{ scale: `1 ${scale}` }, { scale: "1 1" }]);
    }
    motion.start();
  };

  disconnect() {
    this.observer?.disconnect();
    this.observer = null;
    this.stop();
    window.removeEventListener("scroll", this.reset, true);
    window.removeEventListener("resize", this.reset);
    document.removeEventListener("visibilitychange", this.reset);
    this.root = null;
    this.boxes.clear();
  }
}
