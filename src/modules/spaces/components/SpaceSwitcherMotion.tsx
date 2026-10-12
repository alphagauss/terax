/**
 * Space 浮窗的展开与拖放归位。尺寸在状态边界提交，列表裁剪和后续行仅做位移。
 * 收起保留原展示树至过渡结束，滚动、拖动和容器变化会结束临时几何状态。
 */
import { Component, createRef, type ReactNode } from "react";
import { readMotionDurationMs, readMotionEasing } from "@/lib/motion";
import { RevealMotion } from "@/lib/revealMotion";

type Props = {
  expanded: Set<string>;
  open: boolean;
  order: string;
  children: (present: Set<string>) => ReactNode;
};
type State = { present: Set<string>; expanded: Set<string> };
type Region = {
  shell: HTMLElement;
  viewport: HTMLElement;
  content: HTMLElement;
  height: number;
  contentHeight: number;
};
type Snapshot = {
  height: number;
  regions: Region[];
  positions: Map<string, { top: number; visible: boolean }>;
  moving: string | null;
};

function rowPositions(root: HTMLElement) {
  const top = root.getBoundingClientRect().top;
  const view = root
    .querySelector("[data-space-scroller]")
    ?.getBoundingClientRect();
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-space-position]"),
    (element) => {
      const key = element.dataset.spacePosition as string;
      const rect = element.getBoundingClientRect();
      return {
        element,
        key,
        top: rect.top - top,
        visible:
          key === "footer" ||
          (!element.closest("[inert]") &&
            (!view || (rect.bottom > view.top && rect.top < view.bottom))),
      };
    },
  );
}

/** 仅协调选择浮窗内的展示节点，不持有工作页或 Space 的业务生命周期。 */
export class SpaceSwitcherMotion extends Component<
  Props,
  State,
  Snapshot | null
> {
  state: State = {
    present: this.props.expanded,
    expanded: this.props.expanded,
  };
  private root = createRef<HTMLDivElement>();
  private backdrop = createRef<HTMLDivElement>();
  private motion: RevealMotion | null = null;
  private backgroundAnimation: Animation | null = null;
  private observer: ResizeObserver | null = null;
  private restoreScroll: (() => void) | null = null;
  private pendingMove: string | null = null;

  /** 只允许本次拖放提交触发归位，后台数据刷新不播放排序动画。 */
  prepareMove(key: string) {
    this.finish();
    this.pendingMove = key;
  }

  static getDerivedStateFromProps(props: Props, state: State) {
    return props.expanded !== state.expanded
      ? {
          expanded: props.expanded,
          present: new Set([...state.present, ...props.expanded]),
        }
      : null;
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const root = this.root.current;
    const moving =
      previous.order !== this.props.order ? this.pendingMove : null;
    if (!root || (!moving && previous.expanded === this.props.expanded))
      return null;
    const regions = Array.from(
      root.querySelectorAll<HTMLElement>("[data-space-reveal]"),
      (shell) => {
        const viewport = shell.firstElementChild as HTMLElement;
        const content = viewport.firstElementChild as HTMLElement;
        const rect = content.getBoundingClientRect();
        return {
          shell,
          viewport,
          content,
          height: this.motion
            ? Math.max(0, viewport.getBoundingClientRect().bottom - rect.top)
            : shell.getBoundingClientRect().height,
          contentHeight: rect.height,
        };
      },
    );
    const positions = new Map(
      rowPositions(root).map(({ key, top, visible }) => [
        key,
        { top, visible },
      ]),
    );
    return {
      height:
        this.backdrop.current?.getBoundingClientRect().height ??
        root.getBoundingClientRect().height,
      regions,
      positions,
      moving,
    };
  }

  componentDidUpdate(
    previous: Props,
    _state: State,
    snapshot: Snapshot | null,
  ) {
    this.pendingMove = null;
    if (!this.props.open) {
      this.finish();
      return;
    }
    if (!snapshot) {
      if (previous.order !== this.props.order) this.finish();
      return;
    }
    this.motion?.finish(false);
    this.restoreScroll?.();
    this.backgroundAnimation?.cancel();
    this.observer?.disconnect();
    const root = this.root.current;
    const backdrop = this.backdrop.current;
    if (!root || !backdrop) return;
    // 反向切换时，旧动画清理不能覆盖 React 刚提交的开关状态。
    for (const { shell } of snapshot.regions) {
      if (!shell.hasAttribute("data-expanded")) continue;
      shell.style.height = shell.dataset.expanded === "true" ? "" : "0px";
      shell.style.overflow = shell.dataset.expanded === "true" ? "" : "hidden";
    }
    // 先收集最终布局，再写入临时样式；不在动画帧内读取或更新布局。
    const bounds = root.getBoundingClientRect();
    const regions = snapshot.regions.map((region) => ({
      ...region,
      target: region.shell.getBoundingClientRect().height,
      size: region.content.getBoundingClientRect().height,
    }));
    const scroller = root.querySelector<HTMLElement>("[data-space-scroller]");
    const scrollContent = scroller?.firstElementChild as HTMLElement | null;
    const scrollTop = scroller?.scrollTop ?? 0;
    const scrollWidth = scrollContent?.clientWidth ?? 0;
    const view = scroller?.getBoundingClientRect();
    const limit = view?.height ?? window.innerHeight;
    const offsets = new Map<string, number>();
    const followers = rowPositions(root).flatMap(
      ({ element, key, top, visible }) => {
        const before = snapshot.positions.get(key);
        if (!before || (snapshot.moving && (!before.visible || !visible)))
          return [];
        const delta = before.top - top;
        const offset = snapshot.moving
          ? Math.max(-limit, Math.min(limit, delta))
          : delta;
        offsets.set(key, offset);
        return [{ element, key, offset }];
      },
    );
    const motion = new RevealMotion(
      () => {
        this.motion = null;
        this.backgroundAnimation?.cancel();
        this.backgroundAnimation = null;
        this.observer?.disconnect();
        this.restoreScroll?.();
        this.restoreScroll = null;
        this.setState({ present: this.props.expanded });
      },
      snapshot.moving ? "surface" : "control",
    );
    this.motion = motion;
    if (scroller && scrollContent) {
      // 暂时退出滚动容器，防止位移不断改变滚动范围并重绘；宽度和阅读位置保持不变。
      motion.style(scrollContent, "width", `${scrollWidth}px`);
      motion.style(scrollContent, "translate", `0 ${-scrollTop}px`);
      motion.style(scroller, "overflow", "clip");
      this.restoreScroll = () => {
        scroller.scrollTop = scrollTop;
      };
    }
    for (const {
      shell,
      viewport,
      content,
      height,
      contentHeight,
      target,
      size,
    } of regions) {
      if (Math.abs(height - target) < 0.5) continue;
      motion.style(shell, "height", `${target}px`);
      motion.style(shell, "overflow", "visible");
      motion.style(viewport, "position", "absolute");
      motion.style(viewport, "width", "100%");
      motion.style(viewport, "overflow", "hidden");
      // 滚动视口在过渡中保留较大的尺寸，避免收起时提前裁掉退出行。
      if (content.hasAttribute("data-space-scroller"))
        motion.style(content, "height", `${Math.max(height, target)}px`);
      motion.reveal(viewport, content, {
        fromHeight: height,
        toHeight: target,
        contentHeight: Math.max(contentHeight, size),
      });
    }
    for (const { element, key, offset } of followers) {
      // 工作页继承 Space 的位移，只补偿组内变化，跨组按稳定工作页 ID 衔接。
      const parent = element.parentElement?.closest<HTMLElement>(
        "[data-space-motion-row]",
      );
      const parentOffset = parent
        ? (offsets.get(parent.dataset.spacePosition as string) ?? 0)
        : 0;
      motion.move(element, offset - parentOffset);
      if (snapshot.moving && offset !== parentOffset)
        motion.style(element, "z-index", key === snapshot.moving ? "2" : "1");
    }
    const duration = readMotionDurationMs(
      snapshot.moving ? "--dur-surface" : "--dur-control",
      snapshot.moving ? 240 : 160,
    );
    // 仅缩放独立装饰底板，文字与命中区域不参与缩放。
    if (
      duration &&
      bounds.height &&
      backdrop.animate &&
      snapshot.height !== bounds.height
    )
      this.backgroundAnimation = backdrop.animate(
        [
          { transform: `scaleY(${snapshot.height / bounds.height})` },
          { transform: "scaleY(1)" },
        ],
        {
          duration,
          easing: readMotionEasing("--ease-emphasized", "ease"),
          fill: "both",
        },
      );
    this.observer = new ResizeObserver(() => {
      const rect = root.getBoundingClientRect();
      if (
        rect.width !== bounds.width ||
        rect.height !== bounds.height ||
        regions.some(
          ({ content, size }) =>
            !content.hasAttribute("data-space-scroller") &&
            content.getBoundingClientRect().height !== size,
        )
      )
        this.finish();
    });
    this.observer.observe(root);
    for (const { content } of regions) this.observer.observe(content);
    motion.start();
  }

  finish = () => this.motion?.finish();

  componentWillUnmount() {
    this.observer?.disconnect();
    this.motion?.finish(false);
    this.backgroundAnimation?.cancel();
  }

  render() {
    return (
      <div
        ref={this.root}
        className="relative flex flex-col gap-4 p-1.5"
        onWheelCapture={this.finish}
        onKeyDownCapture={(event) => {
          if (
            [
              "Tab",
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
            ].includes(event.key)
          )
            this.finish();
        }}
      >
        <div
          ref={this.backdrop}
          aria-hidden
          className="pointer-events-none absolute inset-0 origin-top rounded-3xl bg-popover shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
        />
        {this.props.children(this.state.present)}
      </div>
    );
  }
}
