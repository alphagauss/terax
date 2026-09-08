/**
 * 本文件测试六工具方案中的读取、写入、补丁和文件树操作。
 * 测试锁定固定会话根、动态审批、默认创建模式及统一原生调用边界。
 */

import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "./context";
import {
  getFileEditRuntime,
  releaseFileEditRuntime,
} from "@/modules/ai/lib/fileEditRuntime";

const nativeMock = vi.hoisted(() => ({
  agentFileRead: vi.fn(),
  agentPrepareMutation: vi.fn(),
  agentCommitMutation: vi.fn(),
  agentClearMutation: vi.fn(),
  agentFileOperation: vi.fn(),
}));

vi.mock("../lib/native", () => ({ native: nativeMock }));

import { buildFsTools } from "./fs";
import { buildPatchTools } from "./patch";
import { buildTools } from "./tools";

const options: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

const context: ToolContext = {
  getCwd: () => "/workspace",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  getSessionId: () => "00000000-0000-4000-8000-000000000001",
  getPermissionMode: () => useChatStore.getState().permissionMode,
  supportsApprovals: true,
};

describe("AI file tools", () => {
  beforeEach(() => {
    releaseFileEditRuntime(context.getSessionId());
    vi.clearAllMocks();
    useChatStore.setState({ permissionMode: "ask" });
    nativeMock.agentFileRead.mockResolvedValue({ content: "1| text" });
    nativeMock.agentPrepareMutation.mockResolvedValue({ files: [] });
    nativeMock.agentCommitMutation.mockResolvedValue({ files: [] });
    nativeMock.agentClearMutation.mockResolvedValue(undefined);
    nativeMock.agentFileOperation.mockResolvedValue({ ok: true });
  });

  it("exposes exactly the six new file tools without legacy aliases", () => {
    const tools = buildTools(context);
    for (const name of [
      "read_file",
      "find_files",
      "grep",
      "write_file",
      "apply_patch",
      "file_operation",
    ]) {
      expect(tools).toHaveProperty(name);
    }
    for (const name of [
      "list_directory",
      "glob",
      "edit",
      "multi_edit",
      "create_directory",
      "open_web_preview",
      "suggest_command",
      "spawn_coding_agent",
      "send_to_agent",
      "read_agent_output",
    ]) {
      expect(tools).not.toHaveProperty(name);
    }
  });

  it("reads through the owner-scoped native backend", async () => {
    const execute = buildFsTools(context).read_file.execute;
    if (!execute) throw new Error("read_file execute missing");
    await execute({ path: "a.txt", start_line: 10, line_count: 20 }, options);
    expect(nativeMock.agentFileRead).toHaveBeenCalledWith({
      ownerSessionId: context.getSessionId(),
      root: "/workspace",
      permissionMode: "ask",
      path: "a.txt",
      startLine: 10,
      lineCount: 20,
      force: undefined,
    });
  });

  it("runs workspace writes automatically and approves outside writes", async () => {
    const tool = buildFsTools(context).write_file;
    if (typeof tool.needsApproval !== "function" || !tool.execute) {
      throw new Error("write_file must support dynamic approval and execution");
    }
    expect(
      tool.needsApproval({ path: "a.txt", content: "text" }, options),
    ).toBe(false);
    expect(
      tool.needsApproval({ path: "../outside.txt", content: "text" }, options),
    ).toBe(true);
    useChatStore.setState({ permissionMode: "full-access" });
    expect(
      tool.needsApproval({ path: "a.txt", content: "text" }, options),
    ).toBe(false);

    await tool.execute({ path: "a.txt", content: "text" }, options);
    expect(nativeMock.agentPrepareMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: "full-access",
        mutation: {
          kind: "write",
          path: "a.txt",
          content: "text",
          mode: "create",
        },
      }),
    );
    expect(nativeMock.agentCommitMutation).toHaveBeenCalledWith(
      context.getSessionId(),
      options.toolCallId,
    );
  });

  it("uses one-call full access after approving an outside read", async () => {
    const tool = buildFsTools(context).read_file;
    if (typeof tool.needsApproval !== "function" || !tool.execute) {
      throw new Error("read_file must support selective approval");
    }
    expect(tool.needsApproval({ path: "../secret.txt" }, options)).toBe(true);

    await tool.execute({ path: "../secret.txt" }, options);

    expect(nativeMock.agentFileRead).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "full-access" }),
    );
  });

  it("returns restricted backend errors when a runner has no approval UI", async () => {
    const tool = buildFsTools({
      ...context,
      supportsApprovals: false,
    }).read_file;
    if (typeof tool.needsApproval !== "function" || !tool.execute) {
      throw new Error("read_file must support non-interactive runners");
    }
    expect(tool.needsApproval({ path: "../secret.txt" }, options)).toBe(false);

    await tool.execute({ path: "../secret.txt" }, options);

    expect(nativeMock.agentFileRead).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "ask" }),
    );
  });

  it("requires approval before moving or deleting the session root", () => {
    const tool = buildFsTools(context).file_operation;
    if (typeof tool.needsApproval !== "function") {
      throw new Error("file_operation approval gate must be dynamic");
    }
    expect(
      tool.needsApproval(
        { operation: "move", path: ".", destination: "archive" },
        options,
      ),
    ).toBe(true);
    expect(
      tool.needsApproval({ operation: "delete", path: "." }, options),
    ).toBe(true);
  });

  it("sends multi-file exact replacements as one prepared patch", async () => {
    const tool = buildPatchTools(context).apply_patch;
    if (!tool.execute) throw new Error("apply_patch execute missing");
    await tool.execute(
      {
        files: [
          {
            path: "a.txt",
            edits: [{ old_text: "a", new_text: "b" }],
          },
          {
            path: "b.txt",
            edits: [{ old_text: "x", new_text: "y", replace_all: true }],
          },
        ],
      },
      options,
    );
    expect(nativeMock.agentPrepareMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: expect.objectContaining({ kind: "patch" }),
      }),
    );
  });

  it("routes structural operations without resolving paths in TypeScript", async () => {
    const execute = buildFsTools(context).file_operation.execute;
    if (!execute) throw new Error("file_operation execute missing");
    await execute(
      {
        operation: "move",
        path: "old.txt",
        destination: "nested/new.txt",
      },
      options,
    );
    expect(nativeMock.agentFileOperation).toHaveBeenCalledWith({
      ownerSessionId: context.getSessionId(),
      root: "/workspace",
      permissionMode: "ask",
      operation: "move",
      path: "old.txt",
      destination: "nested/new.txt",
      recursive: undefined,
    });
  });

  it("提交成功后原位修正统计，文件快照不进入模型工具输出", async () => {
    nativeMock.agentPrepareMutation.mockResolvedValue({
      files: [
        {
          path: "/workspace/a.txt",
          identity: "/workspace/a.txt",
          before: "old\n",
          after: "new\nmore\n",
          isNewFile: false,
          replacements: 1,
        },
      ],
    });
    const output = {
      files: [{ path: "/workspace/a.txt", bytesWritten: 9, replacements: 1 }],
    };
    nativeMock.agentCommitMutation.mockResolvedValue(output);
    const runtime = getFileEditRuntime(context.getSessionId());
    const tool = buildFsTools(context).write_file;
    if (!tool.execute) throw new Error("write_file execute missing");
    const result = await tool.execute(
      { path: "a.txt", content: "new\nmore\n", mode: "rewrite" },
      options,
    );
    expect(result).toEqual(output);
    expect(runtime.getCall(options.toolCallId)).toMatchObject({
      added: 2,
      removed: 1,
      approximate: false,
    });
    expect(runtime.snapshot().files).toEqual([
      {
        path: "a.txt",
        identity: "/workspace/a.txt",
        before: "old\n",
        after: "new\nmore\n",
        isNewFile: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("old");
  });

  it("回滚失败不发布成功快照，并清理原生预备修改", async () => {
    nativeMock.agentPrepareMutation.mockResolvedValue({
      files: [
        {
          path: "/workspace/a.txt",
          identity: "/workspace/a.txt",
          before: "old",
          after: "new",
          isNewFile: false,
        },
      ],
    });
    nativeMock.agentCommitMutation.mockResolvedValue({
      files: [],
      error: "rollback failed",
      uncertainPaths: ["/workspace/a.txt"],
    });
    const tool = buildFsTools(context).write_file;
    if (!tool.execute) throw new Error("write_file execute missing");
    expect(
      await tool.execute({ path: "a.txt", content: "new" }, options),
    ).toMatchObject({ error: "rollback failed" });
    const runtime = getFileEditRuntime(context.getSessionId());
    expect(runtime.snapshot().files).toEqual([]);
    expect(runtime.getCall(options.toolCallId)?.uncertain).toBe(true);
    expect(nativeMock.agentClearMutation).toHaveBeenCalledWith(
      context.getSessionId(),
      options.toolCallId,
    );
  });
});
