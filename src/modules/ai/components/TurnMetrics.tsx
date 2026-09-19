/** 每轮回答的轻量性能提示；只在悬浮或聚焦时订阅和汇总该轮 SDK 记录。 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { MessageAction } from "@/components/ai-elements/message";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/controls/tooltip";
import { summarizePerformance } from "@/modules/ai/lib/usage";
import {
  OutputToolDetails,
  useUsageRecords,
} from "@/modules/ai/components/UsageDetails";

export function TurnMetrics({
  sessionId,
  turnId,
}: {
  sessionId: string;
  turnId: string;
}) {
  const { t } = useTranslation("ai");
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <MessageAction
          label={t("chat.metrics.title")}
          className="size-5 text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={MoreVerticalIcon} size={12} strokeWidth={1.75} />
        </MessageAction>
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        {open && <TurnMetricsContent sessionId={sessionId} turnId={turnId} />}
      </TooltipContent>
    </Tooltip>
  );
}

function TurnMetricsContent({
  sessionId,
  turnId,
}: {
  sessionId: string;
  turnId: string;
}) {
  const records = useUsageRecords(sessionId, true).filter(
    (record) => record.turnId === turnId && !record.taskId && !record.purpose,
  );
  const { t, i18n } = useTranslation("ai");
  const stats = summarizePerformance(records);
  const format = (value: number) =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(
      value,
    );
  const unknown = t("miniWindow.context.unavailable");
  const rows = [
    [
      "firstToken",
      stats.firstOutputMs == null
        ? unknown
        : t("chat.metrics.seconds", {
            value: format(stats.firstOutputMs / 1000),
          }),
    ],
    [
      "speed",
      stats.tokensPerSecond == null
        ? unknown
        : t("chat.metrics.tokensPerSecond", {
            value: format(stats.tokensPerSecond),
          }),
    ],
  ];
  return (
    <div className="space-y-1 text-[11px]">
      <OutputToolDetails records={records} />
      {rows.map(([key, value]) => (
        <div key={key} className="flex justify-between gap-3">
          <span>{t(`chat.metrics.${key}`)}</span>
          <span className="font-mono">{value}</span>
        </div>
      ))}
      {stats.partial && <p>{t("chat.metrics.partial")}</p>}
    </div>
  );
}
