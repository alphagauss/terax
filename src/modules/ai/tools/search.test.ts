/**
 * 本文件测试 AI 路径发现与正文搜索的薄原生桥接。
 * 测试锁定固定会话根目录、新参数命名和旧 glob 工具已经移除。
 */

import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

const nativeMock = vi.hoisted(() => ({
  agentFileFind: vi.fn(),
  agentFileGrep: vi.fn(),
}));

vi.mock("../lib/native", () => ({ native: nativeMock }));

import { buildSearchTools } from "./search";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

function makeContext(): ToolContext {
  return {
    getCwd: () => "/workspace",
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    getSessionId: () => "session",
    getPermissionMode: () => "ask",
  };
}

describe("AI search tools", () => {
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
        output: "count",
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
      output: "count",
      contextLines: 2,
      offset: 10,
      limit: 25,
    });
  });

  it("does not expose the removed standalone glob tool", () => {
    expect(buildSearchTools(makeContext())).not.toHaveProperty("glob");
  });
});
