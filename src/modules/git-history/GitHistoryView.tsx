import type { FindHandle } from "@/modules/find";
import type { GitHistoryTab } from "@/modules/workbench";
import { useCallback } from "react";
import { GitHistoryPane } from "./GitHistoryPane";

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
  visible: boolean;
  onOpenCommitFile: (input: CommitFileDiffOpenInput) => void;
  onFindHandle: (tabId: number, handle: FindHandle | null) => void;
};

export function GitHistoryView({
  tab,
  visible,
  onOpenCommitFile,
  onFindHandle,
}: Props) {
  const handleFind = useCallback(
    (handle: FindHandle | null) => onFindHandle(tab.id, handle),
    [onFindHandle, tab.id],
  );

  return (
    <GitHistoryPane
      repoRoot={tab.repoRoot}
      visible={visible}
      onOpenCommitFile={onOpenCommitFile}
      onFindHandle={handleFind}
    />
  );
}
