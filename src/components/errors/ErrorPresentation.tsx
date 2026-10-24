/** 错误浮窗的展示生命周期：保留退出画面，只对外壳做透明度与位移动画。 */
import { Component, createRef, type ReactNode, type RefObject } from "react";
import type { ErrorReport } from "@/lib/errors";
import { readMotionDurationMs, readMotionEasing } from "@/lib/motion";
import { LayoutMotion } from "@/lib/layoutMotion";

type Props = {
  reports: ErrorReport[];
  history: boolean;
  label: string;
  onPresentChange: (present: boolean) => void;
  renderHeader: (count: number) => ReactNode;
  renderCard: (
    report: ErrorReport,
    historical: boolean,
    scrollRef: RefObject<HTMLDivElement | null>,
  ) => ReactNode;
};
type State = {
  source: ErrorReport[];
  sourceHistory: boolean;
  reports: { report: ErrorReport; historical: boolean }[];
  header: boolean;
  count: number;
};
type Position = {
  top: number;
  left: number;
  width: number;
  opacity: string;
};
type Snapshot = {
  empty: boolean;
  history: boolean;
  moving: boolean;
  opacity: string;
  transform: string;
  listHeight: number;
  listTop: number;
  positions: Map<string, Position>;
};

function visibleReports(props: Props) {
  return props.history
    ? props.reports
    : props.reports.filter((report) => report.visible);
}

function presentedReports(props: Props) {
  return visibleReports(props).map((report) => ({
    report,
    historical: props.history,
  }));
}

/** 历史整体进出，新增错误独立入场，忽略时保留原画面至退场结束。 */
export class ErrorPresentation extends Component<
  Props,
  State,
  Snapshot | null
> {
  state: State = {
    source: this.props.reports,
    sourceHistory: this.props.history,
    reports: presentedReports(this.props),
    header: this.props.history && this.props.reports.length > 0,
    count: this.props.reports.length,
  };
  private root = createRef<HTMLElement>();
  private list = createRef<HTMLDivElement>();
  private animations = new Map<HTMLElement, Animation>();
  private restores: (() => void)[] = [];
  private query: MediaQueryList | null = null;
  private layout = new LayoutMotion({
    surface: "[data-error-surface]",
    retainHeight: true,
  });

  static getDerivedStateFromProps(props: Props, state: State) {
    if (props.reports === state.source && props.history === state.sourceHistory)
      return null;
    const reports = visibleReports(props);
    const ids = new Set(reports.map((report) => report.id));
    return {
      source: props.reports,
      sourceHistory: props.history,
      reports: [
        ...presentedReports(props),
        ...state.reports.filter(({ report }) => !ids.has(report.id)),
      ],
      header: (props.history && reports.length > 0) || state.header,
      count: props.history && reports.length ? reports.length : state.count,
    };
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const before = visibleReports(previous);
    const after = visibleReports(this.props);
    if (
      previous.history === this.props.history &&
      before.length === after.length &&
      before.every((report, index) => report.id === after[index].id)
    )
      return null;
    const root = this.root.current;
    const top = root?.getBoundingClientRect().top ?? 0;
    const style = root ? window.getComputedStyle(root) : null;
    const positions = new Map<string, Position>();
    for (const element of root?.querySelectorAll<HTMLElement>(
      "[data-error-motion]",
    ) ?? []) {
      const rect = element.getBoundingClientRect();
      const parent = element.parentElement;
      const bounds = parent?.getBoundingClientRect();
      positions.set(element.dataset.errorMotion as string, {
        top: rect.top - top,
        left: rect.left - (bounds?.left ?? 0),
        width: rect.width,
        opacity: window.getComputedStyle(element).opacity || "1",
      });
    }
    return {
      empty: before.length === 0,
      history: previous.history,
      moving: !!root && this.animations.has(root),
      opacity: style?.opacity || "1",
      transform: style?.transform || "none",
      listHeight: this.list.current?.getBoundingClientRect().height ?? 0,
      listTop: (this.list.current?.getBoundingClientRect().top ?? top) - top,
      positions,
    };
  }

  componentDidMount() {
    this.props.onPresentChange(this.state.reports.length > 0);
    this.transition(null);
    this.layout.sync(this.list.current, true);
  }

  componentDidUpdate(
    _previous: Props,
    _state: State,
    snapshot: Snapshot | null,
  ) {
    this.props.onPresentChange(this.state.reports.length > 0);
    if (snapshot) this.transition(snapshot);
    this.layout.sync(this.list.current, !!snapshot);
  }

  private style(element: HTMLElement, property: string, value: string) {
    const previous = element.style.getPropertyValue(property);
    element.style.setProperty(property, value);
    this.restores.push(() => {
      if (previous) element.style.setProperty(property, previous);
      else element.style.removeProperty(property);
    });
  }

  private stop() {
    for (const animation of this.animations.values()) {
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
    }
    this.animations = new Map();
    for (const restore of this.restores.reverse()) restore();
    this.restores = [];
    this.query?.removeEventListener("change", this.reduce);
    window.removeEventListener("resize", this.finish);
    this.query = null;
  }

  private finish = () => {
    const animations = this.animations;
    const { reports, history } = this.props;
    // 透明终态保留到 React 移除退出节点之后；同批次的新过渡拥有独立的清理。
    this.setState(
      (_state, props) =>
        props.reports !== reports || props.history !== history
          ? null
          : {
              reports: presentedReports(props),
              header: props.history && props.reports.length > 0,
            },
      () => {
        if (this.animations !== animations) return;
        if (this.props.reports !== reports || this.props.history !== history)
          this.finish();
        else this.stop();
      },
    );
  };

  private reduce = () => {
    if (this.query?.matches) this.finish();
  };

  private animate(element: HTMLElement, frames: Keyframe[], opening: boolean) {
    const animation = element.animate(frames, {
      duration: readMotionDurationMs(
        opening ? "--dur-surface" : "--dur-control",
        opening ? 240 : 160,
      ),
      easing: readMotionEasing(
        "--ease-standard",
        "cubic-bezier(0.4, 0, 0.2, 1)",
      ),
      fill: "both",
    });
    this.animations.set(element, animation);
    animation.onfinish = () => {
      // 完成的动画保留终态，等整批结束后一起释放，避免退出内容闪回。
      if (
        [...this.animations.values()].every(
          (item) => item.playState === "finished",
        )
      )
        this.finish();
    };
    animation.oncancel = this.finish;
  }

  private transition(snapshot: Snapshot | null) {
    this.layout.stop();
    this.stop();
    const root = this.root.current;
    if (!root) return;
    if (!root.animate || !readMotionDurationMs("--dur-control", 160)) {
      this.finish();
      return;
    }
    this.query = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.query.addEventListener("change", this.reduce);
    window.addEventListener("resize", this.finish);
    const reports = visibleReports(this.props);
    const ids = new Set(reports.map((report) => report.id));
    const closing = reports.length === 0;
    const opening =
      !closing &&
      (!snapshot ||
        snapshot.empty ||
        (!snapshot.history && this.props.history));
    if (closing || opening || snapshot?.moving) {
      const continuing = snapshot?.moving;
      this.animate(
        root,
        [
          {
            opacity: continuing || closing ? (snapshot?.opacity ?? "1") : "0",
            transform:
              continuing || closing
                ? (snapshot?.transform ?? "none")
                : "translateY(-8px)",
          },
          {
            opacity: closing ? "0" : "1",
            transform: closing ? "translateY(-8px)" : "none",
          },
        ],
        !closing,
      );
      if (closing) {
        if (snapshot) {
          // 清空可能打断单条退场，冻结其当前画面，避免局部动画取消后闪回。
          if (this.list.current)
            this.style(this.list.current, "height", `${snapshot.listHeight}px`);
          const top = root.getBoundingClientRect().top;
          const positions = Array.from(
            root.querySelectorAll<HTMLElement>("[data-error-motion]"),
            (element) => ({
              element,
              top: element.getBoundingClientRect().top - top,
            }),
          );
          for (const { element, top } of positions) {
            const before = snapshot.positions.get(
              element.dataset.errorMotion as string,
            );
            if (!before) continue;
            this.style(element, "opacity", before.opacity);
            this.style(
              element,
              "transform",
              `translateY(${before.top - top}px)`,
            );
          }
        }
        return;
      }
    }

    const elements = Array.from(
      root.querySelectorAll<HTMLElement>("[data-error-motion]"),
    );
    const exiting = (element: HTMLElement) =>
      element.dataset.errorMotion === "history"
        ? !this.props.history
        : !ids.has(element.dataset.errorMotion as string);
    if (snapshot && elements.some(exiting)) {
      // 退出行立即释放布局，原内容固定在原位置；其他行仅用 transform 补位。
      const outgoing = elements.filter(exiting);
      for (const element of outgoing)
        this.style(element, "position", "absolute");
      const top = root.getBoundingClientRect().top;
      if (this.list.current) {
        // 标题退出布局后保留原可见底边，不能提前裁掉历史底部正在退出的卡片。
        const offset = this.list.current.getBoundingClientRect().top - top;
        this.style(
          this.list.current,
          "height",
          `${snapshot.listHeight + Math.max(0, snapshot.listTop - offset)}px`,
        );
      }
      const positions = outgoing.map((element) => ({
        element,
        parentTop:
          (element.parentElement?.getBoundingClientRect().top ?? top) - top,
      }));
      for (const { element, parentTop } of positions) {
        const before = snapshot.positions.get(
          element.dataset.errorMotion as string,
        );
        if (!before) continue;
        this.style(
          element,
          "top",
          `${before.top - parentTop + (element.parentElement?.scrollTop ?? 0)}px`,
        );
        this.style(element, "left", `${before.left}px`);
        this.style(element, "width", `${before.width}px`);
      }
    }
    const top = root.getBoundingClientRect().top;
    const positions = elements.map((element) => ({
      element,
      top: element.getBoundingClientRect().top - top,
    }));
    for (const { element, top } of positions) {
      const before = snapshot?.positions.get(
        element.dataset.errorMotion as string,
      );
      const leaving = exiting(element);
      if (opening && !leaving) continue;
      const limit = snapshot?.listHeight || window.innerHeight;
      const delta =
        before && !leaving
          ? Math.max(-limit, Math.min(limit, before.top - top))
          : 0;
      if (
        !leaving &&
        before &&
        Math.abs(delta) < 0.5 &&
        Number(before.opacity) === 1
      )
        continue;
      this.animate(
        element,
        [
          {
            opacity: before?.opacity ?? "0",
            transform: `translateY(${before ? delta : -8}px)`,
          },
          {
            opacity: leaving ? "0" : "1",
            transform: leaving ? "translateY(-8px)" : "none",
          },
        ],
        !before && !leaving,
      );
    }
    if (!this.animations.size) this.finish();
  }

  componentWillUnmount() {
    this.layout.disconnect();
    this.stop();
  }

  render() {
    if (!this.state.reports.length) return null;
    const ids = new Set(visibleReports(this.props).map((report) => report.id));
    const closing = ids.size === 0;
    return (
      <aside
        ref={this.root}
        aria-label={this.props.label}
        aria-hidden={closing || undefined}
        inert={closing}
        onScrollCapture={() => {
          if (this.animations.size) this.finish();
        }}
        className={`relative flex max-h-[calc(100dvh-56px)] flex-col gap-2 ${closing ? "pointer-events-none" : "pointer-events-auto"}`}
      >
        {this.state.header && (
          <div
            data-error-motion="history"
            inert={!this.props.history || closing}
            aria-hidden={!this.props.history || closing || undefined}
            className={!this.props.history ? "pointer-events-none" : undefined}
          >
            {this.props.renderHeader(this.state.count)}
          </div>
        )}
        <div
          ref={this.list}
          id="error-history-list"
          className="relative flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain p-0.5 [overflow-anchor:none]"
          aria-live={closing ? "off" : "polite"}
          aria-relevant="additions"
        >
          {this.state.reports.map(({ report, historical }) => (
            <div
              key={report.id}
              data-error-motion={report.id}
              inert={!ids.has(report.id)}
              aria-hidden={!ids.has(report.id) || undefined}
              className={
                !ids.has(report.id) ? "pointer-events-none" : undefined
              }
            >
              {this.props.renderCard(report, historical, this.list)}
            </div>
          ))}
        </div>
      </aside>
    );
  }
}
