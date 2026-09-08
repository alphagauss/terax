/**
 * 本文件计算 Workbench 标签页的显示标题和文件路径提示。
 * 非终端页使用已存标题，终端页优先显示用户命名并在必要时回退到工作目录。
 */

import type { Tab } from "@/modules/workbench";

/**
 * The label shown on a tab. Non-terminal tabs use their stored title; terminal
 * tabs prefer a user-set custom name, then fall back to the last segment of the
 * cwd. Keeping this pure makes the "custom name survives a cd" invariant
 * testable without rendering the bar.
 */
export function labelFor(t: Tab): string {
  if (t.kind === "editor") return t.title;
  if (t.kind === "web-preview") return t.title;
  if (t.kind === "markdown") return t.title;
  if (t.kind === "ai-diff") return t.title;
  if (t.kind === "file-edits") return t.title;
  if (t.kind === "git-diff") return t.title;
  if (t.kind === "git-history") return t.title;
  if (t.kind === "git-commit-file") return t.title;
  if (t.customTitle) return t.customTitle;
  if (!t.cwd) return t.title;
  const parts = t.cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}

/** 返回文件类标签的绝对路径，供标题悬停提示使用。 */
export function filePathFor(t: Tab): string | undefined {
  if (t.kind === "editor" || t.kind === "markdown") return t.path;
  return undefined;
}
