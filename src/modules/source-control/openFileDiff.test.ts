/**
 * 本文件测试 Source Control 文件打开命令。
 * 重复点击同一文件不得被本地选择状态吞掉。
 */

import { describe, expect, it, vi } from "vitest";
import { openSourceControlFileDiff } from "./openFileDiff";

describe("openSourceControlFileDiff", () => {
  it.each([
    { unstaged: true, side: "worktree" as const },
    { unstaged: false, side: "index" as const },
  ])("dispatches every repeated $side open action", ({ unstaged, side }) => {
    const open = vi.fn();
    const file = { path: "file.ts", originalPath: null, unstaged };

    openSourceControlFileDiff("/repo", file, open);
    openSourceControlFileDiff("/repo", file, open);

    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith({
      repoRoot: "/repo",
      path: "file.ts",
      side,
      originalPath: null,
    });
  });
});
