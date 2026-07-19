import type { GitHistoryTab } from "@/modules/workbench";
import { useCallback } from "react";
import { GitHistoryPane, type GitHistorySearchHandle } from "./GitHistoryPane";

type CommitFileDiffOpenInput = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

type Props = {
  tab: GitHistoryTab;
  onOpenCommitFile: (input: CommitFileDiffOpenInput) => void;
  onSearchHandle: (
    tabId: number,
    handle: GitHistorySearchHandle | null,
  ) => void;
};

export function GitHistoryView({
  tab,
  onOpenCommitFile,
  onSearchHandle,
}: Props) {
  const handleSearch = useCallback(
    (handle: GitHistorySearchHandle | null) => onSearchHandle(tab.id, handle),
    [onSearchHandle, tab.id],
  );

  return (
    <GitHistoryPane
      repoRoot={tab.repoRoot}
      onOpenCommitFile={onOpenCommitFile}
      onSearchHandle={handleSearch}
    />
  );
}
