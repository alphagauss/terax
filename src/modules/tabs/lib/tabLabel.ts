/**
 * 本文件计算 Workbench 标签页的显示标题。
 * 非终端页使用已存标题，终端页优先显示用户命名并在必要时回退到工作目录。
 */

import type { Tab } from "@/modules/workbench";

/**
 * 返回标签页显示标题。
 *
 * 保持为纯函数，以便测试终端自定义标题在工作目录变化后仍然有效。
 */
export function labelFor(t: Tab): string {
  if (t.kind === "editor") return t.title;
  if (t.kind === "web-preview") return t.title;
  if (t.kind === "markdown") return t.title;
  if (t.kind === "ai-diff") return t.title;
  if (t.kind === "git-diff") return t.title;
  if (t.kind === "git-history") return t.title;
  if (t.kind === "git-commit-file") return t.title;
  if (t.kind === "alpha-data") return t.title;
  if (t.kind === "alpha-backtests") return t.title;
  if (t.kind === "alpha-settings") return t.title;
  if (t.customTitle) return t.customTitle;
  if (!t.cwd) return t.title;
  const parts = t.cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}
