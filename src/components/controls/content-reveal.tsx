/**
 * 普通文档流内容的展开与切换：提交前记录可见边界，提交后揭示最终内容。
 * 退出只保留原展示实例到过渡结束；后续同列内容同步位移，不延迟显示控件。
 */
import { Component, createRef, type ReactNode, type RefObject } from "react";
import { RevealMotion } from "@/lib/revealMotion";

type Props = {
  open: boolean;
  children: ReactNode;
  transitionKey: string | null;
  /** 滚动列表以实际视口控制揭示进度，避免长内容在前几帧铺满屏幕。 */
  scrollRef?: RefObject<HTMLElement | null>;
};
type State = { present: boolean; lastChildren: ReactNode };
type Snapshot = {
  height: number;
  contentHeight: number;
  followers: { element: HTMLElement; top: number }[];
};

/** 宿主以 data-reveal-boundary 声明同列布局边界，范围内不省略屏外后续项。 */
function followingElements(shell: HTMLElement) {
  const result: Snapshot["followers"] = [];
  const boundary = shell.closest("[data-reveal-boundary], [data-layout-flow]");
  if (!boundary) return result;
  for (
    let branch: Element | null = shell;
    branch && branch !== boundary;
    branch = branch.parentElement
  ) {
    // 通用排列拥有直接子项的补位，揭示只移动该子项内部的后续内容。
    if (
      branch.parentElement === boundary &&
      boundary.hasAttribute("data-layout-flow")
    )
      break;
    for (
      let next = branch.nextElementSibling;
      next;
      next = next.nextElementSibling
    ) {
      if (next instanceof HTMLElement)
        result.push({ element: next, top: next.getBoundingClientRect().top });
    }
  }
  return result;
}

export class ContentReveal extends Component<Props, State, Snapshot | null> {
  state: State = {
    present: this.props.open,
    lastChildren: this.props.children,
  };
  private shell = createRef<HTMLDivElement>();
  private viewport = createRef<HTMLDivElement>();
  private content = createRef<HTMLDivElement>();
  private motion: RevealMotion | null = null;
  private observer: ResizeObserver | null = null;
  private stopScroll: (() => void) | null = null;

  static getDerivedStateFromProps(props: Props, state: State) {
    return props.open &&
      (!state.present || state.lastChildren !== props.children)
      ? { present: true, lastChildren: props.children }
      : null;
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    if (
      previous.open === this.props.open &&
      previous.transitionKey === this.props.transitionKey
    )
      return null;
    const shell = this.shell.current;
    const content = this.content.current;
    const viewport = this.viewport.current;
    if (!shell || !content || !viewport) return null;
    const rect = content.getBoundingClientRect();
    return {
      height: this.motion
        ? Math.max(0, viewport.getBoundingClientRect().bottom - rect.top)
        : previous.open
          ? shell.getBoundingClientRect().height
          : 0,
      contentHeight: rect.height,
      followers: followingElements(shell),
    };
  }

  componentDidUpdate(
    _previous: Props,
    _state: State,
    snapshot: Snapshot | null,
  ) {
    if (!snapshot) return;
    this.motion?.finish(false);
    this.stopScroll?.();
    this.observer?.disconnect();
    const shell = this.shell.current;
    const viewport = this.viewport.current;
    const content = this.content.current;
    if (!shell || !viewport || !content) return;
    // 旧动画的清理不能覆盖本次 React 提交的开关尺寸。
    shell.style.height = this.props.open ? "" : "0px";
    const height = content.getBoundingClientRect().height;
    const width = shell.getBoundingClientRect().width;
    const toHeight = this.props.open ? height : 0;
    const scroll = this.props.scrollRef?.current;
    const bottom = scroll
      ? Math.min(window.innerHeight, scroll.getBoundingClientRect().bottom)
      : window.innerHeight;
    const firstFollower = snapshot.followers[0];
    const beforeTop = firstFollower?.top ?? 0;
    const afterTop = firstFollower?.element.getBoundingClientRect().top ?? 0;
    const followers = snapshot.followers.flatMap(({ element, top }) => {
      const rect = element.getBoundingClientRect();
      // 只动画切换前后与视口相交的内容，屏外项只参与边界测量。
      return Math.min(top, rect.top) < bottom &&
        Math.max(top, rect.top) + rect.height > 0
        ? [
            {
              element,
              from:
                (scroll ? Math.min(beforeTop, bottom) + top - beforeTop : top) -
                rect.top,
              to: scroll ? Math.min(afterTop, bottom) - afterTop : 0,
            },
          ]
        : [];
    });
    const motion = new RevealMotion(() => {
      this.motion = null;
      this.stopScroll?.();
      this.stopScroll = null;
      this.observer?.disconnect();
      if (!this.props.open && this.state.present)
        this.setState({ present: false, lastChildren: null });
    });
    this.motion = motion;
    motion.style(shell, "height", `${toHeight}px`);
    motion.style(shell, "overflow", "visible");
    motion.style(viewport, "position", "absolute");
    motion.style(viewport, "width", "100%");
    motion.style(viewport, "overflow", "hidden");
    if (scroll) {
      // 与 Graph 一样，先将起止边界限制到视口，再复用固定外壳的揭示动画。
      const limit = Math.max(0, bottom - shell.getBoundingClientRect().top);
      const visibleHeight = Math.min(
        Math.max(snapshot.contentHeight, height),
        limit,
      );
      motion.style(viewport, "height", `${visibleHeight}px`);
      motion.revealRow(
        viewport,
        content,
        Math.min(snapshot.height, visibleHeight),
        Math.min(toHeight, visibleHeight),
        visibleHeight,
      );
    } else {
      motion.reveal(viewport, content, {
        fromHeight: snapshot.height,
        toHeight,
        contentHeight: Math.max(snapshot.contentHeight, height),
      });
    }
    for (const { element, from, to } of followers)
      motion.move(element, from, to);
    // 只在过渡期间观测；异步内容和窗口变化直接结束，不重播动效。
    this.observer = new ResizeObserver(() => {
      if (
        shell.getBoundingClientRect().width !== width ||
        content.getBoundingClientRect().height !== height
      )
        motion.finish();
    });
    this.observer.observe(shell);
    this.observer.observe(content);
    if (scroll) {
      // 滚动后立即恢复完整内容，避免新的可见行仍被旧揭示边界裁掉。
      const finish = () => motion.finish();
      scroll.addEventListener("scroll", finish, { passive: true });
      this.stopScroll = () => scroll.removeEventListener("scroll", finish);
    }
    motion.start();
  }

  componentWillUnmount() {
    this.stopScroll?.();
    this.observer?.disconnect();
    this.motion?.finish(false);
  }

  render() {
    const { open, children } = this.props;
    const visible = open || this.state.present;
    return (
      <div
        ref={this.shell}
        data-state={open ? "open" : "closed"}
        aria-hidden={!open}
        inert={!open}
        className="relative min-w-0 data-[state=closed]:overflow-hidden"
        style={open ? undefined : { height: 0 }}
      >
        <div ref={this.viewport} className="pointer-events-none">
          <div ref={this.content} className="pointer-events-auto flow-root">
            {visible ? (open ? children : this.state.lastChildren) : null}
          </div>
        </div>
      </div>
    );
  }
}
