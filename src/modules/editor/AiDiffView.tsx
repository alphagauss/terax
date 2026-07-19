import type { AiDiffTab } from "@/modules/workbench";
import { useCallback } from "react";
import { AiDiffPane } from "./AiDiffPane";

type Props = {
  tab: AiDiffTab;
  onAccept: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
};

export function AiDiffView({ tab, onAccept, onReject }: Props) {
  const handleAccept = useCallback(
    () => onAccept(tab.approvalId),
    [onAccept, tab.approvalId],
  );
  const handleReject = useCallback(
    () => onReject(tab.approvalId),
    [onReject, tab.approvalId],
  );

  return (
    <div className="h-full w-full">
      <AiDiffPane
        path={tab.path}
        originalContent={tab.originalContent}
        proposedContent={tab.proposedContent}
        status={tab.status}
        isNewFile={tab.isNewFile}
        onAccept={handleAccept}
        onReject={handleReject}
      />
    </div>
  );
}
