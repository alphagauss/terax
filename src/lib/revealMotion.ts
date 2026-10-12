/**
 * 揭示动效的共享执行器：布局由宿主一次提交，只移动固定裁剪外壳和原内容。
 * 宿主负责测量、虚拟化与展示生命周期；执行器不持有业务状态，也不逐帧测量。
 */
import { readMotionDurationMs, readMotionEasing } from "@/lib/motion";

export type RevealGeometry = {
  fromHeight: number;
  toHeight: number;
  contentHeight: number;
  offset?: number;
};

/** 一次可取消的过渡，所有临时样式、监听和动画均随同一生命周期释放。 */
export class RevealMotion {
  private animations: Animation[] = [];
  private restores: (() => void)[] = [];
  private ended = false;
  private query = window.matchMedia("(prefers-reduced-motion: reduce)");
  private options: KeyframeAnimationOptions;

  constructor(
    private complete: () => void = () => {},
    preset: "control" | "pane" | "surface" = "control",
  ) {
    this.options = {
      duration: readMotionDurationMs(
        `--dur-${preset}`,
        preset === "pane" ? 150 : preset === "surface" ? 240 : 160,
      ),
      easing: readMotionEasing(
        preset === "pane" ? "--ease-standard" : "--ease-emphasized",
        "ease",
      ),
      fill: "both",
    };
  }

  style(element: HTMLElement, property: string, value: string) {
    const previous = element.style.getPropertyValue(property);
    const priority = element.style.getPropertyPriority(property);
    element.style.setProperty(property, value);
    this.restores.push(() => {
      if (previous) element.style.setProperty(property, previous, priority);
      else element.style.removeProperty(property);
    });
  }

  move(element: HTMLElement, from: number, to = 0) {
    if (!element.animate || !this.options.duration) return;
    if (Math.abs(from - to) < 0.5) {
      if (Math.abs(to) >= 0.5) this.style(element, "translate", `0 ${to}px`);
      return;
    }
    // 独立 translate 不覆盖虚拟行定位或业务自身的 transform。
    this.animations.push(
      element.animate(
        [{ translate: `0 ${from}px` }, { translate: `0 ${to}px` }],
        this.options,
      ),
    );
  }

  /** 虚拟行使用有界外壳，按整个展开区的边界进度依次揭示，图层不随文件总数增长。 */
  revealRow(
    viewport: HTMLElement,
    content: HTMLElement,
    from: number,
    to: number,
    height: number,
  ) {
    if (!viewport.animate || !this.options.duration || from === to) return;
    const points = new Set([0, 1]);
    for (const edge of [0, height]) {
      const progress = (edge - from) / (to - from);
      if (progress > 0 && progress < 1) points.add(progress);
    }
    const frames = [...points]
      .sort((a, b) => a - b)
      .map((offset) => ({
        offset,
        distance:
          height - Math.max(0, Math.min(height, from + (to - from) * offset)),
      }));
    if (frames.every((frame) => frame.distance === frames[0].distance)) {
      this.style(viewport, "translate", `0 ${-frames[0].distance}px`);
      this.style(content, "translate", `0 ${frames[0].distance}px`);
      return;
    }
    this.animations.push(
      viewport.animate(
        frames.map(({ offset, distance }) => ({
          offset,
          translate: `0 ${-distance}px`,
        })),
        this.options,
      ),
      content.animate(
        frames.map(({ offset, distance }) => ({
          offset,
          translate: `0 ${distance}px`,
        })),
        this.options,
      ),
    );
  }

  reveal(
    viewport: HTMLElement,
    content: HTMLElement,
    geometry: RevealGeometry,
  ) {
    const { fromHeight, toHeight, contentHeight, offset = 0 } = geometry;
    const height = Math.max(contentHeight, fromHeight, toHeight);
    // 长正文只在屏幕范围内揭示，不为屏外高度创建巨型移动裁剪层。
    const limit = window.innerHeight;
    if (limit > 0 && height > limit && offset === 0) {
      this.style(viewport, "height", `${limit}px`);
      this.revealRow(viewport, content, fromHeight, toHeight, limit);
      return;
    }
    const from = height - fromHeight;
    const to = height - toHeight;
    this.style(viewport, "height", `${height}px`);
    this.move(viewport, offset - from, -to);
    this.move(content, from, to);
  }

  start() {
    if (!this.animations.length) {
      this.finish();
      return;
    }
    this.query.addEventListener("change", this.reduce);
    this.restores.push(() =>
      this.query.removeEventListener("change", this.reduce),
    );
    for (const animation of this.animations)
      animation.oncancel = () => this.finish();
    this.animations[0].onfinish = () => this.finish();
  }

  private reduce = () => {
    if (this.query.matches) this.finish();
  };

  finish(notify = true) {
    if (this.ended) return;
    this.ended = true;
    for (const animation of this.animations) {
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
    }
    for (const restore of this.restores.reverse()) restore();
    if (notify) this.complete();
  }
}
