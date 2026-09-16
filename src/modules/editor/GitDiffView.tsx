/**
 * 本文件把 Workbench 的 Git diff 标签映射到对应的只读差异页面。
 * working 与 commit 标签使用独立组件，避免共享互斥的加载生命周期。
 */

import type { FindHandle } from "@/modules/find";
import type { GitCommitFileDiffTab, GitDiffTab } from "@/modules/workbench";
import { forwardRef } from "react";
import { CommitGitDiffPane, WorkingGitDiffPane } from "./GitDiffPane";

type Props = {
  tab: GitDiffTab | GitCommitFileDiffTab;
  visible: boolean;
};

/** 根据标签资源类型渲染工作区或历史提交差异。 */
export const GitDiffView = forwardRef<FindHandle, Props>(function GitDiffView(
  { tab, visible },
  ref,
) {
  return (
    <div className="h-full w-full">
      {tab.kind === "git-diff" ? (
        <WorkingGitDiffPane ref={ref} active={visible} source={tab} />
      ) : (
        <CommitGitDiffPane ref={ref} source={tab} />
      )}
    </div>
  );
});
