/**
 * 本文件测试 AI 文件修改的原生桥接。
 * 测试锁定新工具输入映射、提交键和异步清理，不保留旧编辑工具契约。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMock = vi.hoisted(() => ({
  agentPrepareMutation: vi.fn(),
  agentCommitMutation: vi.fn(),
  agentClearMutation: vi.fn(),
}));

vi.mock("../lib/native", () => ({ native: nativeMock }));

import {
  clearPreparedFileMutation,
  commitPreparedFileMutation,
  isTerminalFileMutationState,
  prepareFileMutation,
} from "./fileMutation";

describe("file mutation bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeMock.agentPrepareMutation.mockResolvedValue({ files: [] });
    nativeMock.agentCommitMutation.mockResolvedValue({ files: [] });
    nativeMock.agentClearMutation.mockResolvedValue(undefined);
  });

  it("maps a complete write to an explicit native mode", async () => {
    await prepareFileMutation({
      sessionId: "session",
      toolCallId: "call",
      toolName: "write_file",
      input: { path: "a.txt", content: "after", mode: "rewrite" },
      cwd: "/workspace",
      permissionMode: "ask",
    });

    expect(nativeMock.agentPrepareMutation).toHaveBeenCalledWith({
      ownerSessionId: "session",
      toolCallId: "call",
      root: "/workspace",
      permissionMode: "ask",
      mutation: {
        kind: "write",
        path: "a.txt",
        content: "after",
        mode: "rewrite",
      },
    });
  });

  it("maps a multi-file exact patch without compatibility fields", async () => {
    await prepareFileMutation({
      sessionId: "session",
      toolCallId: "call",
      toolName: "apply_patch",
      input: {
        edits: [
          {
            path: "a.txt",
            old_text: "before",
            new_text: "after",
            replace_all: true,
            expected_replacements: 2,
          },
          { path: "b.txt", old_text: "x", new_text: "y" },
          {
            path: "a.txt",
            old_text: "after",
            new_text: "final",
            replace_all: true,
          },
        ],
      },
      cwd: "/workspace",
      permissionMode: "full-access",
    });

    expect(nativeMock.agentPrepareMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: {
          kind: "patch",
          files: [
            {
              path: "a.txt",
              edits: [
                {
                  old_text: "before",
                  new_text: "after",
                  replace_all: true,
                  expected_replacements: 2,
                },
                { old_text: "after", new_text: "final", replace_all: true },
              ],
            },
            { path: "b.txt", edits: [{ old_text: "x", new_text: "y" }] },
          ],
        },
      }),
    );
  });

  it("commits and clears by owner plus tool call", async () => {
    await commitPreparedFileMutation("session", "call");
    clearPreparedFileMutation("session", "call");
    await vi.waitFor(() =>
      expect(nativeMock.agentClearMutation).toHaveBeenCalledWith(
        "session",
        "call",
      ),
    );
    expect(nativeMock.agentCommitMutation).toHaveBeenCalledWith(
      "session",
      "call",
    );
  });

  it("recognizes only terminal approval states", () => {
    expect(isTerminalFileMutationState("approval-requested")).toBe(false);
    expect(isTerminalFileMutationState("approval-responded")).toBe(false);
    expect(isTerminalFileMutationState("output-available")).toBe(true);
    expect(isTerminalFileMutationState("output-error")).toBe(true);
    expect(isTerminalFileMutationState("output-denied")).toBe(true);
  });
});
