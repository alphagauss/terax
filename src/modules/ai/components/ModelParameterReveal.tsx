/**
 * 模型参数的展开与内容切换：提交前记录可见边界，提交后揭示最终内容。
 * 退出只保留原展示实例到过渡结束；后续同列内容同步位移，不延迟显示控件。
 */
import { Component, createRef, type ReactNode } from "react";
import { RevealMotion } from "@/lib/revealMotion";

type Props = {
  open: boolean;
  children: ReactNode;
  transitionKey: string | null;
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
  const boundary = shell.closest("[data-reveal-boundary]");
  if (!boundary) return result;
  for (
    let branch: Element | null = shell;
    branch && branch !== boundary;
    branch = branch.parentElement
  ) {
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

export class ModelParameterReveal extends Component<
  Props,
  State,
  Snapshot | null
> {
  state: State = {
    present: this.props.open,
    lastChildren: this.props.children,
  };
  private shell = createRef<HTMLDivElement>();
  private viewport = createRef<HTMLDivElement>();
  private content = createRef<HTMLDivElement>();
  private motion: RevealMotion | null = null;
  private observer: ResizeObserver | null = null;

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
    const followers = snapshot.followers.flatMap(({ element, top }) => {
      const rect = element.getBoundingClientRect();
      // 只动画切换前后与视口相交的内容，屏外项只参与边界测量。
      return Math.min(top, rect.top) < window.innerHeight &&
        Math.max(top, rect.top) + rect.height > 0
        ? [{ element, offset: top - rect.top }]
        : [];
    });
    const motion = new RevealMotion(() => {
      this.motion = null;
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
    motion.reveal(viewport, content, {
      fromHeight: snapshot.height,
      toHeight,
      contentHeight: Math.max(snapshot.contentHeight, height),
    });
    for (const { element, offset } of followers) motion.move(element, offset);
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
    motion.start();
  }

  componentWillUnmount() {
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
