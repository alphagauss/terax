/**
 * 本文件定义 Workbench 标签页、分组和递归布局的公共类型。
 * 页面类型只描述可渲染状态，不承载页面组件或运行时资源。
 */

import type { GitDiffSide } from "@/modules/source-control/gitTypes";

export const DEFAULT_SPACE_ID = "default";

export type WorkbenchDirection = "up" | "down" | "left" | "right";
export type WorkbenchAxis = "row" | "col";

type TabBase = {
  id: number;
  spaceId: string;
  cold?: boolean;
  title: string;
};

export type TerminalTab = TabBase & {
  kind: "terminal";
  cwd?: string;
  blocks?: boolean;
  private?: boolean;
  customTitle?: string;
};

export type EditorTab = TabBase & {
  kind: "editor";
  path: string;
  dirty: boolean;
  preview: boolean;
  explorerRoot?: string;
};

export type WebPreviewTab = TabBase & {
  kind: "web-preview";
  url: string;
};

export type MarkdownTab = TabBase & {
  kind: "markdown";
  path: string;
  dirty: boolean;
  preview: boolean;
  explorerRoot?: string;
};

export type AiDiffStatus = "pending" | "approved" | "rejected";

export type AiDiffTab = TabBase & {
  kind: "ai-diff";
  sessionId: string;
  path: string;
  originalContent: string;
  proposedContent: string;
  requestKey: string;
  status: AiDiffStatus;
  isNewFile: boolean;
};

export type GitDiffTab = TabBase & {
  kind: "git-diff";
  path: string;
  repoRoot: string;
  side: GitDiffSide;
  originalPath: string | null;
};

export type GitHistoryTab = TabBase & {
  kind: "git-history";
  repoRoot: string;
};

export type GitCommitFileDiffTab = TabBase & {
  kind: "git-commit-file";
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

export type Tab =
  | TerminalTab
  | EditorTab
  | WebPreviewTab
  | MarkdownTab
  | AiDiffTab
  | GitDiffTab
  | GitHistoryTab
  | GitCommitFileDiffTab;

export type TabPatch = Partial<{
  title: string;
  cwd: string;
  path: string;
  dirty: boolean;
  preview: boolean;
  url: string;
  customTitle: string;
  explorerRoot: string;
  originalPath: string | null;
  shortSha: string;
  subject: string;
}>;

export type WorkbenchGroup = {
  id: number;
  tabIds: number[];
  activeTabId: number | null;
};

export type WorkbenchLayoutNode =
  | { kind: "group"; id: number; groupId: number }
  | {
      kind: "split";
      id: number;
      axis: WorkbenchAxis;
      children: WorkbenchLayoutNode[];
      sizes?: number[];
    };

export type SpaceWorkbench = {
  root: WorkbenchLayoutNode;
  groups: Record<number, WorkbenchGroup>;
  activeGroupId: number;
};

export type WorkbenchState = {
  tabs: Record<number, Tab>;
  spaces: Record<string, SpaceWorkbench>;
};
