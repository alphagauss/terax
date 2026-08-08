/**
 * 本文件把 Source Control 文件行映射为显式 Git diff 打开命令。
 * 打开动作无选择缓存，每次用户触发都必须传递给 Workbench。
 */

import type { GitDiffResource } from "./gitTypes";

type ChangedFile = {
  path: string;
  originalPath: string | null;
  unstaged: boolean;
};

/** 每次调用都打开对应资源，未暂存变化优先于暂存变化。 */
export function openSourceControlFileDiff(
  repoRoot: string,
  file: ChangedFile,
  open: (resource: GitDiffResource) => void,
): void {
  open({
    repoRoot,
    path: file.path,
    side: file.unstaged ? "worktree" : "index",
    originalPath: file.originalPath,
  });
}
