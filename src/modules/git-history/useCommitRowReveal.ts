/**
 * 提交展开的虚拟行适配：逻辑行与滚动总尺寸一次提交，只暂留原来已挂载的可见行。
 * 每行固定尺寸裁剪，不复制列表、不逐帧驱动虚拟器；加载和滚动直接结束过渡。
 */
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { RevealMotion } from "@/lib/revealMotion";
import type { CommitGraphItem } from "@/modules/git-history/useCommitGraph";

type Row = {
  item: CommitGraphItem;
  start: number;
  size: number;
  exiting?: boolean;
};
type Snapshot = {
  sha: string;
  boundary: number;
  logicalBoundary: number;
  tops: Map<string, number>;
  positions: Map<string, number>;
};

export function useCommitRowReveal(
  items: CommitGraphItem[],
  visible: { index: number; start: number; size: number }[],
  scroll: RefObject<HTMLDivElement | null>,
  rowHeight: number,
  identity: string,
  enabled: boolean,
) {
  const elements = useRef(new Map<string, HTMLDivElement>());
  const boundaryRef = useRef<HTMLDivElement>(null);
  const motion = useRef<RevealMotion | null>(null);
  const pending = useRef<Snapshot | null>(null);
  const [retained, setRetained] = useState<Row[]>([]);
  const [minimumHeight, setMinimumHeight] = useState(0);
  const activeSha = useRef<string | null>(null);
  const latestItems = useRef(items);
  const currentIdentity = useRef(identity);
  const currentEnabled = useRef(enabled);
  const viewportSize = useRef("");
  const liveRows: Row[] = visible.flatMap((row) =>
    items[row.index]
      ? [{ item: items[row.index], start: row.start, size: row.size }]
      : [],
  );
  const rowsByKey = new Map(liveRows.map((row) => [row.item.key, row]));
  const positions = useMemo(
    () => new Map(items.map((item, index) => [item.key, index * rowHeight])),
    [items, rowHeight],
  );
  for (const row of retained) {
    if (rowsByKey.has(row.item.key)) continue;
    const start = positions.get(row.item.key);
    rowsByKey.set(row.item.key, {
      ...row,
      start: start ?? row.start,
      exiting: start === undefined,
    });
  }
  const rows = [...rowsByKey.values()];

  const endOf = (sha: string) => {
    let index = items.findIndex(
      (item) => item.kind === "commit" && item.commit.sha === sha,
    );
    if (index < 0) return 0;
    index++;
    while (index < items.length && items[index].commit.sha === sha) index++;
    return index * rowHeight;
  };

  const finish = () => {
    pending.current = null;
    motion.current?.finish();
  };
  const releaseScrollSpace = () => setMinimumHeight(0);

  const capture = (sha: string) => {
    if (!scroll.current || !enabled) return;
    const base =
      scroll.current.getBoundingClientRect().top - scroll.current.scrollTop;
    const boundary =
      activeSha.current === sha && motion.current && boundaryRef.current
        ? boundaryRef.current.getBoundingClientRect().top - base
        : endOf(sha);
    const tops = new Map<string, number>();
    for (const [key, element] of elements.current)
      tops.set(key, element.getBoundingClientRect().top - base);
    // 先读取当前合成位置，再取消旧动画，反向点击不跳回上一次端点。
    motion.current?.finish(false);
    motion.current = null;
    pending.current = {
      sha,
      boundary,
      logicalBoundary: endOf(sha),
      tops,
      positions,
    };
    activeSha.current = sha;
    const top = scroll.current.scrollTop;
    const bottom = top + scroll.current.clientHeight;
    setRetained(
      rows.filter((row) => {
        const y = tops.get(row.item.key) ?? row.start;
        return y < bottom && y + row.size > top;
      }),
    );
    // 收起后的总行数可能不足以维持 scrollTop，保留阅读视口至下一次主动滚动。
    setMinimumHeight(scroll.current.scrollTop + scroll.current.clientHeight);
  };

  useLayoutEffect(() => {
    const snapshot = pending.current;
    pending.current = null;
    // 虚拟器已有尺寸观测并触发提交，这里不另建重复的 ResizeObserver。
    const size = `${scroll.current?.clientWidth}:${scroll.current?.clientHeight}`;
    const invalidated =
      viewportSize.current !== size ||
      currentIdentity.current !== identity ||
      currentEnabled.current !== enabled;
    viewportSize.current = size;
    currentIdentity.current = identity;
    currentEnabled.current = enabled;
    const dataChanged = latestItems.current !== items;
    latestItems.current = items;
    if (invalidated || (!snapshot && dataChanged)) {
      motion.current?.finish();
      if (snapshot) setRetained([]);
      if (invalidated) setMinimumHeight(0);
      return;
    }
    if (!snapshot || !scroll.current) return;
    const toBoundary = endOf(snapshot.sha);
    const viewTop = scroll.current.scrollTop;
    const viewBottom = viewTop + scroll.current.clientHeight + rowHeight;
    const inView = (position: number) =>
      Math.max(viewTop, Math.min(viewBottom, position));
    const fromEdge = inView(snapshot.boundary);
    const toEdge = inView(toBoundary);
    const animation = new RevealMotion(() => {
      motion.current = null;
      activeSha.current = null;
      setRetained([]);
    });
    motion.current = animation;
    if (boundaryRef.current) {
      boundaryRef.current.style.top = `${toEdge}px`;
      animation.move(boundaryRef.current, fromEdge - toEdge);
    }
    for (const row of rows) {
      const element = elements.current.get(row.item.key);
      if (!element) continue;
      // 结束后先恢复零高度裁剪，再等待 React 卸载，退出行不能短暂重新露出。
      if (row.exiting) animation.style(element, "overflow", "visible");
      const downstream =
        row.item.commit.sha !== snapshot.sha && row.start >= toBoundary;
      const oldPosition = snapshot.positions.get(row.item.key) ?? row.start;
      // 收起时新进入虚拟范围的标题也从旧边界进入，不能先闪现在最终位置。
      const capturedTop = snapshot.tops.get(row.item.key);
      const before =
        (downstream && capturedTop !== undefined && capturedTop > viewBottom
          ? undefined
          : capturedTop) ??
        (downstream
          ? fromEdge + oldPosition - snapshot.logicalBoundary
          : row.start);
      const after = downstream ? toEdge + row.start - toBoundary : row.start;
      if (
        Math.min(before, after) < viewBottom &&
        Math.max(before, after) + row.size > viewTop
      )
        animation.move(element, before - row.start, after - row.start);
      if (row.item.kind !== "commit" && row.item.commit.sha === snapshot.sha) {
        const viewport = element.firstElementChild as HTMLElement;
        const content = viewport.firstElementChild as HTMLElement;
        animation.revealRow(
          viewport,
          content,
          fromEdge - before,
          toEdge - row.start,
          row.size,
        );
      }
    }
    animation.start();
  });

  useLayoutEffect(() => () => motion.current?.finish(false), []);
  return {
    rows,
    elements,
    boundaryRef,
    capture,
    finish,
    minimumHeight,
    releaseScrollSpace,
  };
}
