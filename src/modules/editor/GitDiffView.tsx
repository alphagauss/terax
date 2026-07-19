import type { GitCommitFileDiffTab, GitDiffTab } from "@/modules/workbench";
import { useMemo } from "react";
import { GitDiffPane } from "./GitDiffPane";

type Props = {
  tab: GitDiffTab | GitCommitFileDiffTab;
  visible: boolean;
};

export function GitDiffView({ tab, visible }: Props) {
  const source = useMemo(
    () =>
      tab.kind === "git-diff"
        ? {
            kind: "working" as const,
            repoRoot: tab.repoRoot,
            path: tab.path,
            mode: tab.mode,
            originalPath: tab.originalPath,
          }
        : {
            kind: "commit" as const,
            repoRoot: tab.repoRoot,
            sha: tab.sha,
            path: tab.path,
            originalPath: tab.originalPath,
          },
    [tab],
  );

  return (
    <div className="h-full w-full">
      <GitDiffPane active={visible} source={source} />
    </div>
  );
}
