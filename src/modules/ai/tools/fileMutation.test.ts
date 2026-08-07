/**
 * 本文件测试 AI 文件修改快照的纯文本变换规则。
 * 测试锁定批量原子顺序、唯一替换和失败时不返回部分结果。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTextEdits,
  clearPreparedFileMutation,
  commitPreparedFileMutation,
  getPreparedFileMutation,
  isTerminalFileMutationState,
  prepareFileMutation,
} from "./fileMutation";

const nativeMock = vi.hoisted(() => ({
  canonicalize: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../lib/native", () => ({ native: nativeMock }));

describe("file mutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeMock.canonicalize.mockImplementation(async (path: string) => path);
    nativeMock.writeFile.mockResolvedValue(undefined);
  });

  it("applies ordered edits to the running buffer", () => {
    expect(
      applyTextEdits("alpha beta", [
        { old_string: "alpha", new_string: "gamma" },
        { old_string: "gamma beta", new_string: "done" },
      ]),
    ).toEqual({ content: "done", replacements: 2 });
  });

  it("rejects an ambiguous single replacement", () => {
    expect(() =>
      applyTextEdits("same same", [
        { old_string: "same", new_string: "changed" },
      ]),
    ).toThrow("not unique");
  });

  it("counts replace-all operations", () => {
    expect(
      applyTextEdits("x-x-x", [
        { old_string: "x", new_string: "y", replace_all: true },
      ]),
    ).toEqual({ content: "y-y-y", replacements: 3 });
  });

  it("keeps the approved snapshot until the tool reaches a terminal state", () => {
    expect(isTerminalFileMutationState("approval-requested")).toBe(false);
    expect(isTerminalFileMutationState("approval-responded")).toBe(false);
    expect(isTerminalFileMutationState("output-available")).toBe(true);
    expect(isTerminalFileMutationState("output-error")).toBe(true);
    expect(isTerminalFileMutationState("output-denied")).toBe(true);
  });

  it("shares one preparation for concurrent callers", async () => {
    let resolveRead!: (value: { kind: "text"; content: string }) => void;
    nativeMock.readFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );

    const input = {
      sessionId: "session",
      toolCallId: "tool-concurrent",
      toolName: "write_file" as const,
      input: { path: "a.txt", content: "after" },
      cwd: "/workspace",
    };
    const first = prepareFileMutation(input);
    const second = prepareFileMutation(input);
    await vi.waitFor(() => expect(nativeMock.readFile).toHaveBeenCalledOnce());
    resolveRead({ kind: "text", content: "before" });

    const [firstPrepared, secondPrepared] = await Promise.all([first, second]);
    expect(secondPrepared).toBe(firstPrepared);
    expect(getPreparedFileMutation(input.sessionId, input.toolCallId)).toBe(
      firstPrepared,
    );
  });

  it("does not let a cleared in-flight preparation repopulate the cache", async () => {
    let resolveRead!: (value: { kind: "text"; content: string }) => void;
    nativeMock.readFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const input = {
      sessionId: "session",
      toolCallId: "tool-cleared",
      toolName: "write_file" as const,
      input: { path: "a.txt", content: "after" },
      cwd: "/workspace",
    };
    const preparing = prepareFileMutation(input);
    await vi.waitFor(() => expect(nativeMock.readFile).toHaveBeenCalledOnce());
    clearPreparedFileMutation(input.sessionId, input.toolCallId);
    resolveRead({ kind: "text", content: "before" });
    await preparing;

    expect(
      getPreparedFileMutation(input.sessionId, input.toolCallId),
    ).toBeNull();
  });

  it("writes the exact approved snapshot when the source is unchanged", async () => {
    nativeMock.readFile.mockResolvedValue({
      kind: "text",
      content: "before",
    });
    const prepared = await prepareFileMutation({
      sessionId: "session",
      toolCallId: "tool-commit",
      toolName: "edit",
      input: {
        path: "a.txt",
        old_string: "before",
        new_string: "after",
      },
      cwd: "/workspace",
    });

    await commitPreparedFileMutation(prepared);

    expect(nativeMock.writeFile).toHaveBeenCalledWith(
      "/workspace/a.txt",
      "after",
    );
  });

  it("refuses to overwrite a file changed after approval", async () => {
    nativeMock.readFile
      .mockResolvedValueOnce({ kind: "text", content: "before" })
      .mockResolvedValueOnce({ kind: "text", content: "change" });
    const prepared = await prepareFileMutation({
      sessionId: "session",
      toolCallId: "tool-stale",
      toolName: "write_file",
      input: { path: "a.txt", content: "approved" },
      cwd: "/workspace",
    });

    await expect(commitPreparedFileMutation(prepared)).rejects.toThrow(
      "file changed after approval",
    );
    expect(nativeMock.writeFile).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an empty file created after new-file approval", async () => {
    nativeMock.readFile
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce({ kind: "text", content: "" });
    const prepared = await prepareFileMutation({
      sessionId: "session",
      toolCallId: "tool-created",
      toolName: "write_file",
      input: { path: "new.txt", content: "approved" },
      cwd: "/workspace",
    });

    await expect(commitPreparedFileMutation(prepared)).rejects.toThrow(
      "file changed after approval",
    );
    expect(nativeMock.writeFile).not.toHaveBeenCalled();
  });
});
