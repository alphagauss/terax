import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";
import { buildTerminalTools } from "./terminal";

const context: ToolContext = {
  getCwd: () => "/workspace",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  getSessionId: () => "session",
  getPermissionMode: () => "ask",
  supportsApprovals: true,
};

const options = {
  toolCallId: "call",
  messages: [],
  context: undefined as never,
};

describe("get_terminal_output", () => {
  it("使用 offset 读取上一页，不重复末尾已读取的行", async () => {
    const buffer = Array.from({ length: 160 }, (_, i) => `line ${i + 1}`);
    const getTerminalContext = vi.fn((maxLines: number) =>
      buffer.slice(-maxLines).join("\n"),
    );
    const tool = buildTerminalTools({
      ...context,
      getTerminalContext,
    }).get_terminal_output;
    expect(await tool.execute?.({ lines: 80, offset: 0 }, options)).toEqual({
      output: buffer.slice(80).join("\n"),
      lines_returned: 80,
      truncated: false,
    });
    expect(await tool.execute?.({ lines: 80, offset: 80 }, options)).toEqual({
      output: buffer.slice(0, 80).join("\n"),
      lines_returned: 80,
      truncated: false,
    });
    expect(getTerminalContext).toHaveBeenLastCalledWith(160);
  });

  it.each([
    [1, "first", 1],
    [2, "", 0],
    [2000, "", 0],
  ])(
    "偏移接近或超出保留历史时只返回可用行：%s",
    async (offset, output, count) => {
      const tool = buildTerminalTools({
        ...context,
        getTerminalContext: () => "first\nlast",
      }).get_terminal_output;
      expect(await tool.execute?.({ offset }, options)).toEqual({
        output,
        lines_returned: count,
        truncated: false,
      });
    },
  );

  it.each([-1, 0.5])("拒绝无效偏移：%s", async (offset) => {
    const schema = asSchema(
      buildTerminalTools(context).get_terminal_output.inputSchema,
    );
    if (!schema.validate) throw new Error("missing schema validator");
    expect(await schema.validate({ offset })).toMatchObject({ success: false });
  });

  it("分页选中的空白行仍计入返回行数", async () => {
    const tool = buildTerminalTools({
      ...context,
      getTerminalContext: () => "first\n\nlast",
    }).get_terminal_output;
    expect(await tool.execute?.({ lines: 1, offset: 1 }, options)).toEqual({
      output: "",
      lines_returned: 1,
      truncated: false,
    });
  });

  it("字符截断只保留请求页的尾部，不混入跳过的行", async () => {
    const tool = buildTerminalTools({
      ...context,
      getTerminalContext: () => `${"x".repeat(30_000)}\nnew`,
    }).get_terminal_output;
    const result = await tool.execute?.({ lines: 1, offset: 1 }, options);
    expect(result).toMatchObject({ lines_returned: 1, truncated: true });
    if (!result || !("output" in result) || typeof result.output !== "string")
      throw new Error("missing output");
    expect(result.output).toHaveLength(24_000);
    expect(result.output.endsWith("x")).toBe(true);
    expect(result.output).not.toContain("new");
  });

  it("返回可用的尾部行数，不用请求行数冒充实际数量", async () => {
    const getTerminalContext = vi.fn(() => "first\nlast");
    const tool = buildTerminalTools({
      ...context,
      getTerminalContext,
    }).get_terminal_output;
    expect(await tool.execute?.({ lines: 1000 }, options)).toEqual({
      output: "first\nlast",
      lines_returned: 2,
      truncated: false,
    });
    expect(getTerminalContext).toHaveBeenCalledWith(1000);
  });

  it("正文恰好达到字符上限时不截断", async () => {
    const output = "x".repeat(24_000);
    const tool = buildTerminalTools({
      ...context,
      getTerminalContext: () => output,
    }).get_terminal_output;
    expect(await tool.execute?.({}, options)).toEqual({
      output,
      lines_returned: 1,
      truncated: false,
    });
  });

  it.each([
    [Array.from({ length: 1000 }, () => "x".repeat(100)).join("\n"), 1000],
    ["x".repeat(30_000), 1],
  ])("字符截断保留尾部并统计实际正文行数", async (buffer, lines) => {
    const tool = buildTerminalTools({
      ...context,
      getTerminalContext: () => buffer,
    }).get_terminal_output;
    const result = await tool.execute?.({ lines }, options);
    expect(result).toMatchObject({ truncated: true });
    if (!result || !("output" in result) || typeof result.output !== "string")
      throw new Error("missing output");
    const marker = "…[truncated]…\n";
    expect(result.output).toHaveLength(24_000);
    expect(result.output.startsWith(marker)).toBe(true);
    const body = result.output.slice(marker.length);
    expect(buffer.endsWith(body)).toBe(true);
    expect(result.lines_returned).toBe(body.split("\n").length);
    if (lines > 1) expect(result.lines_returned).toBeLessThan(lines);
  });

  it("隐私终端拒绝读取缓冲区", async () => {
    const getTerminalContext = vi.fn(() => "secret");
    const tool = buildTerminalTools({
      ...context,
      getTerminalContext,
      isActiveTerminalPrivate: () => true,
    }).get_terminal_output;
    expect(await tool.execute?.({ lines: 2000 }, options)).toHaveProperty(
      "error",
    );
    expect(getTerminalContext).not.toHaveBeenCalled();
  });

  it("没有活动终端时返回空输出", async () => {
    const tool = buildTerminalTools(context).get_terminal_output;
    expect(await tool.execute?.({}, options)).toEqual({
      output: "",
      note: "no active terminal",
    });
  });
});
