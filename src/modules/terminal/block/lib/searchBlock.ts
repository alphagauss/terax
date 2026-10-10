/** 将逻辑文本的匹配映射回终端单元格，保留宽字符和软换行的位置。 */
import type { IBuffer } from "@xterm/xterm";

type Segment = { line: number; col: number; len: number };
export type BlockMatch = { line: number; segments: Segment[] };

export function searchRange(
  buffer: IBuffer,
  start: number,
  end: number,
  query: string,
): BlockMatch[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const matches: BlockMatch[] = [];
  let text = "";
  let cells: Segment[] = [];
  const flush = () => {
    for (let from = 0; matches.length < 500; ) {
      const index = text.indexOf(needle, from);
      if (index < 0) break;
      const segments: Segment[] = [];
      for (const cell of cells.slice(index, index + needle.length)) {
        const last = segments[segments.length - 1];
        if (last?.line === cell.line) last.len = cell.col + cell.len - last.col;
        else segments.push({ ...cell });
      }
      if (segments.length) matches.push({ line: segments[0].line, segments });
      from = index + needle.length;
    }
    text = "";
    cells = [];
  };
  for (
    let row = Math.max(0, start);
    row <= Math.min(end, buffer.length - 1);
    row++
  ) {
    const line = buffer.getLine(row);
    if (!line?.isWrapped) flush();
    if (matches.length >= 500) break;
    if (!line) continue;
    let endColumn = line.length;
    while (endColumn > 0) {
      const cell = line.getCell(endColumn - 1);
      if (cell?.getChars() || cell?.getWidth() === 0) break;
      endColumn--;
    }
    for (let col = 0; col < endColumn; col++) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = (cell.getChars() || " ").toLowerCase();
      text += chars;
      for (let i = 0; i < chars.length; i++)
        cells.push({ line: row, col, len: cell.getWidth() });
    }
  }
  flush();
  return matches;
}
