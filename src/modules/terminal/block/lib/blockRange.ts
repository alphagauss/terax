/** 输出范围由实时标记生成。结束标记不包含在输出中；end < start 表示无输出。 */

export type MarkerLike = { line: number; isDisposed: boolean };

export type LineRange = { start: number; end: number };

export function computeRange(
  start: MarkerLike,
  end: MarkerLike,
): LineRange | null {
  if (start.isDisposed || end.isDisposed) return null;
  if (start.line < 0 || end.line < 0) return null;
  return { start: start.line, end: Math.max(start.line - 1, end.line - 1) };
}

export function blockIndexAt(
  ranges: (LineRange | null)[],
  line: number,
): number {
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    if (r && line >= r.start && line <= r.end) return i;
  }
  return -1;
}
