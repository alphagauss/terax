/**
 * 普通文档流的二维布局位移，卡片与控件共用测量、续接和清理逻辑。
 * 真实布局一次提交，只移动原元素；背景缩放由宿主显式声明独立图层。
 */
import { RevealMotion } from "@/lib/revealMotion";

type Box = { left: number; top: number; width: number; height: number };
type Options = { surface?: string; retainHeight?: boolean };

/** 每个局部作用域只观察容器及直接子项，不扫描控件后代或浮层。 */
export class LayoutMotion {
  private root: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private elements = new Set<HTMLElement>();
  private boxes = new Map<HTMLElement, Box>();
  private motion: RevealMotion | null = null;
  private frame: number | null = null;
  private width = 0;
  private height = 0;
  private query: MediaQueryList | null = null;

  constructor(private options: Options = {}) {}

  private measure() {
    const boxes = new Map<HTMLElement, Box>();
    for (const element of this.elements) {
      if (!element.getClientRects().length) continue;
      boxes.set(element, {
        left: element.offsetLeft,
        top: element.offsetTop,
        width: element.offsetWidth,
        height: element.offsetHeight,
      });
    }
    return boxes;
  }

  /** 宿主提交后同步集合；首次显示或恢复时只建立基线。 */
  sync(root: HTMLElement | null, reset = false) {
    if (this.root !== root) {
      this.disconnect();
      this.root = root;
      if (root) {
        this.observer = new ResizeObserver(this.update);
        this.observer.observe(root);
        window.addEventListener("scroll", this.onScroll, true);
        window.addEventListener("resize", this.reset);
        document.addEventListener("visibilitychange", this.reset);
        this.query = window.matchMedia("(prefers-reduced-motion: reduce)");
        this.query.addEventListener("change", this.reset);
      }
      reset = true;
    }
    const next = new Set(
      [...(root?.children ?? [])].filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement &&
          !element.inert &&
          !element.hidden &&
          element.getAttribute("aria-hidden") !== "true",
      ),
    );
    for (const element of this.elements)
      if (!next.has(element)) this.observer?.unobserve(element);
    for (const element of next)
      if (!this.elements.has(element))
        this.observer?.observe(element, { box: "border-box" });
    this.elements = next;
    if (reset) this.reset();
  }

  /** 纯换序与同尺寸对齐变化没有尺寸通知，合并到下一帧比较位置。 */
  schedule() {
    if (this.root && this.frame === null)
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.update();
      });
  }

  stop() {
    this.motion?.finish(false);
    this.motion = null;
  }

  private reset = () => {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.stop();
    this.boxes = this.measure();
    this.width = this.root?.clientWidth ?? 0;
    if (this.options.retainHeight)
      this.height = this.root?.getBoundingClientRect().height ?? 0;
  };

  private onScroll = (event: Event) => {
    // 后代或其他面板滚动不改变本组几何，避免打断动效并重复测量。
    if (event.target instanceof Element && !event.target.contains(this.root))
      return;
    this.reset();
  };

  private viewport(root: HTMLElement, origin: DOMRect) {
    let left = 0,
      top = 0,
      right = window.innerWidth,
      bottom = window.innerHeight;
    // 取裁剪祖先的交集，局部滚动面板不能用整个窗口代替。
    for (
      let current: HTMLElement | null = root;
      current;
      current = current.parentElement
    ) {
      const style = window.getComputedStyle(current);
      const clipY = /(auto|scroll|hidden|clip)/.test(
        style.overflowY || style.overflow,
      );
      const clipX = /(auto|scroll|hidden|clip)/.test(
        style.overflowX || style.overflow,
      );
      if (!clipX && !clipY) continue;
      const rect = current === root ? origin : current.getBoundingClientRect();
      if (clipY) {
        top = Math.max(top, rect.top);
        bottom = Math.min(bottom, rect.bottom);
      }
      if (clipX) {
        left = Math.max(left, rect.left);
        right = Math.min(right, rect.right);
      }
    }
    if (this.options.retainHeight) {
      top = Math.max(top, origin.top);
      bottom = Math.min(bottom, origin.bottom);
    }
    return { left, top, right, bottom };
  }

  private update = () => {
    const root = this.root;
    if (!root) return;
    if (
      document.hidden ||
      this.query?.matches ||
      this.width !== root.clientWidth
    ) {
      this.reset();
      return;
    }
    const next = this.measure();
    if (
      next.size === this.boxes.size &&
      [...next].every(([element, box]) => {
        const old = this.boxes.get(element);
        return (
          old &&
          old.left === box.left &&
          old.top === box.top &&
          old.width === box.width &&
          old.height === box.height
        );
      })
    ) {
      if (this.options.retainHeight && !this.motion)
        this.height = root.getBoundingClientRect().height;
      return;
    }
    const origin = root.getBoundingClientRect();
    const viewport = this.viewport(root, origin);
    // offset 不包含动画；取消前读取当前位移，让快速反向从视觉位置继续。
    const changes = [...next].flatMap(([element, box]) => {
      const old = this.boxes.get(element);
      if (!old) return [];
      const translate = (window.getComputedStyle(element).translate || "0 0")
        .split(" ")
        .map((value) => Number.parseFloat(value) || 0);
      const surface = this.options.surface
        ? element.querySelector<HTMLElement>(this.options.surface)
        : null;
      const scales = (
        surface ? window.getComputedStyle(surface).scale || "1" : "1"
      )
        .split(" ")
        .map(Number);
      const newX = origin.left + box.left - root.scrollLeft;
      const newY = origin.top + box.top - root.scrollTop;
      const oldX = origin.left + old.left + translate[0] - root.scrollLeft;
      const oldY = origin.top + old.top + (translate[1] ?? 0) - root.scrollTop;
      if (
        Math.min(oldX, newX) >= viewport.right ||
        Math.max(oldX + old.width, newX + box.width) <= viewport.left ||
        Math.min(oldY, newY) >= viewport.bottom ||
        Math.max(oldY + old.height, newY + box.height) <= viewport.top
      )
        return [];
      const edgeX = viewport.left - Math.max(old.width, box.width);
      const edgeY = viewport.top - Math.max(old.height, box.height);
      const clampX = (x: number) =>
        Math.max(edgeX, Math.min(viewport.right, x));
      const clampY = (y: number) =>
        Math.max(edgeY, Math.min(viewport.bottom, y));
      return [
        {
          element,
          surface,
          fromX: clampX(oldX) - newX,
          toX: clampX(newX) - newX,
          fromY: clampY(oldY) - newY,
          toY: clampY(newY) - newY,
          scaleX: box.width ? (old.width * scales[0]) / box.width : 1,
          scaleY: box.height
            ? (old.height * (scales[1] ?? scales[0])) / box.height
            : 1,
        },
      ];
    });
    this.stop();
    this.boxes = next;
    const motion = new RevealMotion(() => {
      this.motion = null;
    });
    this.motion = motion;
    // 错误历史收起时保留旧底边，退出卡片由原宿主负责清理。
    if (this.options.retainHeight) {
      const height = root.getBoundingClientRect().height;
      motion.style(root, "height", `${Math.max(this.height, height)}px`);
      this.height = height;
    }
    for (const {
      element,
      surface,
      fromX,
      toX,
      fromY,
      toY,
      scaleX,
      scaleY,
    } of changes) {
      if (fromX === 0 && toX === 0) motion.move(element, fromY, toY);
      else if (Math.abs(fromX - toX) >= 0.5 || Math.abs(fromY - toY) >= 0.5)
        motion.animate(element, [
          { translate: `${fromX}px ${fromY}px` },
          { translate: `${toX}px ${toY}px` },
        ]);
      if (
        surface &&
        Number.isFinite(scaleX) &&
        Number.isFinite(scaleY) &&
        (Math.abs(scaleX - 1) >= 0.001 || Math.abs(scaleY - 1) >= 0.001)
      )
        motion.animate(surface, [
          { scale: `${scaleX} ${scaleY}` },
          { scale: "1 1" },
        ]);
    }
    motion.start();
  };

  disconnect() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.observer?.disconnect();
    this.observer = null;
    this.stop();
    window.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("resize", this.reset);
    document.removeEventListener("visibilitychange", this.reset);
    this.query?.removeEventListener("change", this.reset);
    this.query = null;
    this.root = null;
    this.elements.clear();
    this.boxes.clear();
  }
}
