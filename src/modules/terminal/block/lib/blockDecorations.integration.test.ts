// @vitest-environment happy-dom
import { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import conptyResize from "./__fixtures__/conpty-resize.json";
import { BlockDecorations } from "./blockDecorations";
import { readRangeText } from "./readBlock";

it("真实 xterm 中多行与软换行输出在缩放后仍共用边界", async () => {
  const term = new Terminal({ cols: 40, rows: 20, allowProposedApi: true });
  const decorate = vi.spyOn(term, "registerDecoration");
  const deco = new BlockDecorations(term);
  const write = (text: string) =>
    new Promise<void>((resolve) => term.write(text, resolve));
  const osc = (text: string) => `\x1b]133;${text}\x1b\\`;
  try {
    for (let i = 0; i < 3; i++) {
      await write(
        `${osc("A")}user@${"host".repeat(14)}$ ${osc("B")}ls -l\r\n${osc("C")}total 4\r\n${"directory ".repeat(8)}\r\n${osc("D;0")}`,
      );
    }
    await write(`${osc("A")}user$ ${osc("B")}`);
    for (const [cols, rows] of [
      [40, 20],
      [20, 6],
      [70, 30],
      [30, 8],
      [80, 20],
    ]) {
      term.resize(cols, rows);
      const blocks = deco.getBlocks();
      expect(blocks).toHaveLength(3);
      for (const [index, block] of blocks.entries()) {
        expect(deco.readById(block.id)?.output).toBe(
          `total 4\n${"directory ".repeat(8)}`,
        );
        expect(readRangeText(term, block.startLine, block.endLine)).toBe(
          `total 4\n${"directory ".repeat(8)}`,
        );
        // 实际分隔线装饰与读取范围持有同一结束标记，缩放后仍是输出之外的第一行。
        expect(decorate.mock.calls[index * 2][0].marker.line).toBe(
          block.endLine + 1,
        );
        expect(decorate.mock.calls[index * 2 + 1][0].marker.isDisposed).toBe(
          false,
        );
      }
    }
    await write("\x1b[2J\x1b[H");
    term.reset();
    expect(deco.getBlocks()).toEqual([]);
  } finally {
    deco.dispose();
    term.dispose();
    vi.restoreAllMocks();
  }
});

it.each([
  ["", "", 0],
  ["\r\n\r\n", "", 2],
  ["text\r\n\r\n", "text", 2],
  ["tail", "tail", 1],
  ["tail\r", "tail", 1],
  ["   ", "   ", 1],
  [`${"中文".repeat(30)}\r\nnext\r\n`, `${"中文".repeat(30)}\nnext`, 7],
])("真实网格边界不串入下一条命令：%j", async (output, expected, rows) => {
  const term = new Terminal({ cols: 20, rows: 3, allowProposedApi: true });
  const deco = new BlockDecorations(term);
  const write = (text: string) =>
    new Promise<void>((resolve) => term.write(text, resolve));
  const osc = (text: string) => `\x1b]133;${text}\x1b\\`;
  try {
    await write(`\r\n${osc("B")}command\r\n${osc("C")}${output}${osc("D;0")}`);
    const block = deco.getBlocks()[0];
    expect(block.endLine - block.startLine + 1).toBe(rows);
    expect(deco.readById(block.id)?.output).toBe(expected);
    await write(`\r\n${osc("A")}NEXT_PROMPT${osc("B")}`);
    expect(deco.readById(block.id)?.output).toBe(expected);
    expect(deco.searchBlock(block.id, "NEXT_PROMPT")).toEqual([]);
    const range = deco.getBlocks()[0];
    expect(readRangeText(term, range.startLine, range.endLine)).toBe(expected);
    const select = vi.spyOn(term, "selectLines");
    deco.selectBlock(block.id);
    if (rows === 0) expect(select).not.toHaveBeenCalled();
    else expect(select).toHaveBeenCalledWith(range.startLine, range.endLine);
  } finally {
    deco.dispose();
    term.dispose();
  }
});

// 来自真实 WSL/ConPTY 的匿名化数据流，包含长输出、多行输入及四次宽高调整。
it("ConPTY 重绘后撤销旧定位但保留完整复制，不能把运行中的残余输出拆成新块", async () => {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const deco = new BlockDecorations(term, { invalidateOnResize: true });
  const write = (text: string) =>
    new Promise<void>((resolve) => term.write(text, resolve));
  const osc = (value: string) => `\x1b]133;${value}\x1b\\`;
  let resized = false;
  let snapshots: { id: string; output: string }[] = [];
  try {
    for (const frame of conptyResize) {
      if (frame.data !== undefined) await write(frame.data);
      else {
        if (!resized) {
          expect(deco.getBlocks()).toHaveLength(3);
          snapshots = deco.getBlocks().map((b) => ({
            id: b.id,
            output: deco.readById(b.id)?.output ?? "",
          }));
          expect(snapshots[0].output).toContain("ROW_45");
        }
        term.resize(frame.cols, frame.rows);
        resized = true;
      }
      if (resized) {
        expect(deco.getBlocks()).toEqual([]);
        for (const snapshot of snapshots) {
          expect(deco.readById(snapshot.id)?.output).toBe(snapshot.output);
          expect(deco.searchBlock(snapshot.id, "ROW")).toEqual([]);
        }
        expect(deco.visibleBlocks().recent).toHaveLength(3);
      }
    }
    await write(`${osc("B")}${osc("C")}partial\r\n`);
    term.resize(term.cols + 5, term.rows);
    await write(`${osc("C")}remaining\r\n${osc("D;0")}`);
    expect(deco.getBlocks()).toEqual([]);
    await write(
      `${osc("A")}${osc("B")}echo next\r\n${osc("C")}AFTER_RESIZE\r\n${osc("D;0")}`,
    );
    expect(deco.getBlocks()).toHaveLength(1);
    expect(deco.readById(deco.getBlocks()[0].id)?.output).toBe("AFTER_RESIZE");
  } finally {
    deco.dispose();
    term.dispose();
  }
});

it("空闲时缩放不等待重复 B，新提交连续恢复命令块与操作锚点", async () => {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const decorate = vi.spyOn(term, "registerDecoration");
  const deco = new BlockDecorations(term, { invalidateOnResize: true });
  const write = (text: string) =>
    new Promise<void>((resolve) => term.write(text, resolve));
  const osc = (value: string) => `\x1b]133;${value}\x1b\\`;
  try {
    await write(`${osc("A")}prompt$ ${osc("B")}`);
    for (const cols of [60, 100, 50]) {
      term.resize(cols, 24);
      // Readline 只重绘文字，不一定重发 B。
      await write("\r\x1b[2Kprompt$ ");
      expect(deco.beginSubmission()).toBe(true);
      await write(`echo next\r\n${osc("C")}NEXT\r\n${osc("D;0")}`);
      expect(deco.getBlocks()).toHaveLength(1);
      expect(deco.readById(deco.getBlocks()[0].id)?.output).toBe("NEXT");
      // 除结束装饰外，还必须有菜单入口的命令锚点。
      expect(
        decorate.mock.calls[decorate.mock.calls.length - 1]?.[0]
          .overviewRulerOptions,
      ).toBeUndefined();
      await write(`${osc("A")}prompt$ ${osc("B")}`);
    }
    // 提交后、C 到达前，输入框清空也可能使终端尺寸变化；新命令尚未输出，不能丢弃。
    expect(deco.beginSubmission()).toBe(true);
    term.resize(70, 24);
    await write(`echo pending\r\n${osc("C")}PENDING\r\n${osc("D;0")}`);
    expect(deco.getBlocks()).toHaveLength(1);
    expect(deco.readById(deco.getBlocks()[0].id)?.output).toBe("PENDING");
    expect(
      decorate.mock.calls[decorate.mock.calls.length - 1]?.[0]
        .overviewRulerOptions,
    ).toBeUndefined();
  } finally {
    deco.dispose();
    term.dispose();
    vi.restoreAllMocks();
  }
});
