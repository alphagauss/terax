import type { Terminal } from "@xterm/xterm";

export function readRangeText(
  term: Terminal,
  startLine: number,
  endLine: number,
): string {
  const buf = term.buffer.active;
  const last = Math.min(endLine, buf.length - 1);
  const lines: string[] = [];
  for (let i = Math.max(0, startLine); i <= last; i++) {
    const line = buf.getLine(i);
    // 与 xterm 原生选区复制一致，去掉未使用的网格单元格。
    const text = line?.translateToString(true) ?? "";
    if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
