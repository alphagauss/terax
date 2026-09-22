/**
 * 本文件测试 AI 路径发现与正文搜索的薄原生桥接。
 * 测试锁定固定会话根目录、新参数命名和旧 glob 工具已经移除。
 */

import { asSchema, type ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

const nativeMock = vi.hoisted(() => ({
  agentFileFind: vi.fn(),
  agentFileGrep: vi.fn(),
}));

vi.mock("../lib/native", () => ({ native: nativeMock }));

import { buildToolApproval } from "./approval";
import { buildSearchTools } from "./search";

const toolOptions: ToolExecutionOptions<never> = {
  toolCallId: "tool-call",
  messages: [],
  context: undefined as never,
};

function makeContext(): ToolContext {
  return {
    getCwd: () => "/workspace",
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    getSessionId: () => "session",
    getPermissionMode: () => "ask",
    supportsApprovals: true,
  };
}

describe("AI search tools", () => {
  it.each([
    [undefined, "not-applicable"],
    ["src", "not-applicable"],
    ["../outside", "user-approval"],
    [".ssh", "user-approval"],
  ] as const)("搜索路径 %s 使用请求级审批策略", (path, expected) => {
    const policy = buildToolApproval(makeContext());
    expect(policy.find_files({ path })).toBe(expected);
    expect(policy.grep({ path, pattern: "text" })).toBe(expected);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    nativeMock.agentFileFind.mockResolvedValue({ entries: [] });
    nativeMock.agentFileGrep.mockResolvedValue({ hits: [] });
  });

  it("uses find_files for immediate or recursive discovery", async () => {
    const execute = buildSearchTools(makeContext()).find_files.execute;
    if (!execute) throw new Error("find_files execute missing");

    await execute(
      {
        path: "src",
        glob: "**/*.ts",
        recursive: true,
        include_directories: true,
        offset: 20,
        limit: 50,
      },
      toolOptions,
    );

    expect(nativeMock.agentFileFind).toHaveBeenCalledWith({
      ownerSessionId: "session",
      root: "/workspace",
      permissionMode: "ask",
      path: "src",
      glob: "**/*.ts",
      recursive: true,
      includeDirectories: true,
      includeHidden: undefined,
      offset: 20,
      limit: 50,
    });
  });

  it("maps grep modes and context to the unified backend", async () => {
    const execute = buildSearchTools(makeContext()).grep.execute;
    if (!execute) throw new Error("grep execute missing");

    await execute(
      {
        pattern: "literal text",
        path: "src",
        syntax: "literal",
        output: "content",
        context_lines: 2,
        include: ["**/*.ts"],
        offset: 10,
        limit: 25,
      },
      toolOptions,
    );

    expect(nativeMock.agentFileGrep).toHaveBeenCalledWith({
      ownerSessionId: "session",
      root: "/workspace",
      permissionMode: "ask",
      path: "src",
      pattern: "literal text",
      syntax: "literal",
      caseInsensitive: undefined,
      include: ["**/*.ts"],
      output: "content",
      contextLines: 2,
      offset: 10,
      limit: 25,
    });
  });

  it("describes search defaults and only allows zero context for aggregate output", async () => {
    const tools = buildSearchTools(makeContext());
    const grepSchema = asSchema(tools.grep.inputSchema);
    const jsonSchema = await grepSchema.jsonSchema;
    const properties = jsonSchema.properties as Record<
      string,
      { description?: string }
    >;

    expect(properties.syntax.description).toContain("Defaults to regex");
    expect(properties.output.description).toContain("Defaults to content");
    expect(properties.limit.description).toContain("Defaults to 30");
    expect(tools.find_files.description).toContain("require approval");
    if (!grepSchema.validate) throw new Error("grep validator missing");
    for (const output of ["files", "count"]) {
      expect(
        await grepSchema.validate({
          pattern: "needle",
          output,
          context_lines: 2,
        }),
      ).toMatchObject({ success: false });
      expect(
        await grepSchema.validate({
          pattern: "needle",
          output,
          context_lines: 0,
        }),
      ).toMatchObject({ success: true });
    }
    expect(
      await grepSchema.validate({
        pattern: "needle",
        output: "content",
        context_lines: 2,
      }),
    ).toMatchObject({ success: true });
  });

  it("does not expose the removed standalone glob tool", () => {
    expect(buildSearchTools(makeContext())).not.toHaveProperty("glob");
  });
});
