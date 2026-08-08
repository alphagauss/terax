/**
 * 本文件定义 Git 差异资源的跨模块领域类型。
 * side 使用明确的数据源名称，禁止用符号或布尔值隐含暂存语义。
 */

/** Git 差异的可变侧，分别表示工作区变化与暂存区变化。 */
export type GitDiffSide = "worktree" | "index";

/** 工作区 Git 差异标签页的稳定资源身份。 */
export type GitDiffResource = {
  repoRoot: string;
  path: string;
  side: GitDiffSide;
  originalPath: string | null;
};
