/**
 * 本文件连接 AI 文件审批标签与只读 diff 页面。
 * 接受或拒绝通过跨会话唯一请求键路由，不直接写入文件。
 */

import type { AiDiffTab } from "@/modules/workbench";
import { useCallback } from "react";
import { AiDiffPane } from "./AiDiffPane";

type Props = {
  tab: AiDiffTab;
  onAccept: (requestKey: string) => void;
  onReject: (requestKey: string) => void;
};

/** 将审批请求键绑定到 diff 页面的接受和拒绝操作。 */
export function AiDiffView({ tab, onAccept, onReject }: Props) {
  const handleAccept = useCallback(
    () => onAccept(tab.requestKey),
    [onAccept, tab.requestKey],
  );
  const handleReject = useCallback(
    () => onReject(tab.requestKey),
    [onReject, tab.requestKey],
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
