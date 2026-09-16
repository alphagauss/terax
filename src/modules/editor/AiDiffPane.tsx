/**
 * 本文件渲染 AI 文件修改的只读 CodeMirror diff。
 * 页面只响应整次工具审批，不直接执行或持久化文件修改。
 */

import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import { Badge } from "@/components/ui/badge";
import { computeLineStats } from "@/modules/ai/lib/fileEditDiff";
import { ReadonlyDiff } from "@/modules/editor/ReadonlyDiff";
import type { FindHandle } from "@/modules/find";
import type { AiDiffStatus } from "@/modules/workbench";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { forwardRef, useMemo } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  path: string;
  originalContent: string;
  proposedContent: string;
  status: AiDiffStatus;
  isNewFile: boolean;
  onAccept: () => void;
  onReject: () => void;
};

const STATUS_LABEL_KEY: Record<AiDiffStatus, string> = {
  pending: "statusPending",
  approved: "statusApproved",
  rejected: "statusRejected",
};

const STATUS_BADGE: Record<
  AiDiffStatus,
  "outline" | "secondary" | "destructive"
> = {
  pending: "outline",
  approved: "secondary",
  rejected: "destructive",
};

/** 渲染一次文件工具调用的只读差异及整体审批操作。 */
export const AiDiffPane = forwardRef<FindHandle, Props>(function AiDiffPane(
  {
    path,
    originalContent,
    proposedContent,
    status,
    isNewFile,
    onAccept,
    onReject,
  },
  ref,
) {
  const { t } = useTranslation("editor");
  const stats = useMemo(
    () => computeLineStats(originalContent, proposedContent),
    [originalContent, proposedContent],
  );

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-border/60 bg-background">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            className="text-[11px] px-2.5 py-2.5"
            variant={STATUS_BADGE[status]}
          >
            {t(STATUS_LABEL_KEY[status])}
          </Badge>
          {isNewFile ? (
            <span className="shrink-0 rounded-full border border-border/60 bg-accent/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("newFile")}
            </span>
          ) : null}
          <Hint content={path}>
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {path}
            </span>
          </Hint>
          <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] tabular-nums">
            <span className="text-success">+{stats.added}</span>
            <span className="text-destructive">−{stats.removed}</span>
          </span>
        </div>
        {status === "pending" ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="default" onClick={onAccept}>
              <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2} />
              {t("accept")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onReject}>
              <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} />
              {t("reject")}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ReadonlyDiff
          ref={ref}
          path={path}
          before={originalContent}
          after={proposedContent}
          focusable
        />
      </div>
    </div>
  );
});
