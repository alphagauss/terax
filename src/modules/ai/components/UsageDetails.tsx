/** 主 Agent 与子任务共用的用量明细：上下文和缓存均取末次请求。 */
import { useChatDisplaySnapshot } from "@/modules/ai/hooks/chatDisplay";

import { Hint } from "@/components/controls/tooltip";
import {
  getProvider,
  providerFromBuiltinId,
  type ModelRef,
} from "@/modules/ai/config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  summarizeOutput,
  summarizeSessionUsage,
  type UsageRecord,
} from "@/modules/ai/lib/usage";
import { subscribeUsage, usageRecords } from "@/modules/ai/lib/usageRuntime";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export function useUsageRecords(sessionId: string, settled = false) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeUsage(sessionId, listener),
    [sessionId],
  );
  const snapshot = useCallback(
    () => usageRecords(sessionId, settled),
    [sessionId, settled],
  );
  return useChatDisplaySnapshot(subscribe, snapshot);
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function UsageDetails({ records }: { records: readonly UsageRecord[] }) {
  const { t } = useTranslation("ai");
  const latest = records[records.length - 1];
  const input = latest?.values.inputTokens;
  const cached = latest?.values.cacheReadTokens;
  const cacheRate =
    input && cached != null && !latest?.estimated.includes("inputTokens")
      ? cached / input
      : undefined;
  return (
    <div className="space-y-1 text-[11px]">
      {(["inputTokens", "cacheReadTokens"] as const).map((field) => {
        const value = latest?.values[field];
        return (
          <div
            key={field}
            className="flex items-baseline justify-between gap-3 text-muted-foreground"
          >
            <span>{t(`miniWindow.context.${field}`)}</span>
            <Hint content={value?.toLocaleString()}>
              <span className="text-right font-mono text-foreground">
                {value == null ? (
                  t("miniWindow.context.unavailable")
                ) : (
                  <>
                    {formatTokens(value)}
                    {field === "cacheReadTokens" &&
                      cacheRate != null &&
                      ` / ${(cacheRate * 100).toFixed(0)}%`}
                    {field === "inputTokens" &&
                      latest?.estimated.includes(field) &&
                      ` · ${t("miniWindow.context.estimated")}`}
                  </>
                )}
              </span>
            </Hint>
          </div>
        );
      })}
    </div>
  );
}

/** 当前上下文取末次主请求，会话用量累计主任务、子任务与压缩请求。 */
export function SessionUsageDetails({
  context,
  records,
}: {
  context: UsageRecord;
  records: readonly UsageRecord[];
}) {
  const { t } = useTranslation("ai");
  const summary = summarizeSessionUsage(records);
  const cacheRate =
    summary.cacheReadTokens == null
      ? undefined
      : summary.cacheReadTokens /
        (summary.cacheReadTokens + (summary.noCacheTokens ?? 0));
  const rows = [
    {
      key: "inputTokens",
      value: context.values.inputTokens,
      estimated: context.estimated.includes("inputTokens"),
    },
    {
      key: "cacheInputTokens",
      value: summary.cacheReadTokens,
      suffix:
        cacheRate == null || !Number.isFinite(cacheRate)
          ? undefined
          : ` / ${(cacheRate * 100).toFixed(1)}%`,
    },
    { key: "uncachedInputTokens", value: summary.noCacheTokens },
    {
      key: "outputTokens",
      value: summary.outputTokens,
      estimated: summary.outputEstimated,
    },
  ];
  return (
    <div className="space-y-1 text-[11px]">
      {rows.map(({ key, value, suffix, estimated }) => (
        <div
          key={key}
          className="flex items-baseline justify-between gap-3 text-muted-foreground"
        >
          <span>{t(`miniWindow.context.${key}`)}</span>
          <Hint content={value?.toLocaleString()}>
            <span className="text-right font-mono text-foreground">
              {value == null ? (
                t("miniWindow.context.unavailable")
              ) : (
                <>
                  {formatTokens(value)}
                  {suffix}
                  {estimated && ` · ${t("miniWindow.context.estimated")}`}
                </>
              )}
            </span>
          </Hint>
        </div>
      ))}
    </div>
  );
}

/** 每轮三点菜单展示该轮末次模型请求的缓存命中。 */
export function LatestRequestCacheDetails({
  records,
}: {
  records: readonly UsageRecord[];
}) {
  const { t } = useTranslation("ai");
  const latest = records[records.length - 1];
  const input = latest?.values.inputTokens;
  const cached = latest?.values.cacheReadTokens;
  const rate =
    input && cached != null && !latest.estimated.includes("inputTokens")
      ? cached / input
      : undefined;
  return (
    <div className="flex justify-between gap-3">
      <span>{t("chat.metrics.latestRequestCache")}</span>
      <Hint content={cached?.toLocaleString()}>
        <span className="font-mono">
          {cached == null
            ? t("miniWindow.context.unavailable")
            : `${formatTokens(cached)}${rate == null ? "" : ` / ${(rate * 100).toFixed(1)}%`}`}
        </span>
      </Hint>
    </div>
  );
}

/** 主回答与子任务共用的输出及工具计数，缺失旧记录不伪装成零。 */
export function OutputToolDetails({
  records,
}: {
  records: readonly UsageRecord[];
}) {
  const { t } = useTranslation("ai");
  const summary = summarizeOutput(records);
  const unknown = t("miniWindow.context.unavailable");
  return (
    <div className="space-y-1 text-[11px]">
      <div className="flex justify-between gap-3">
        <span>{t("chat.metrics.output")}</span>
        <span className="font-mono">
          {summary.outputTokens == null
            ? unknown
            : `${t("chat.metrics.tokens", { value: formatTokens(summary.outputTokens) })}${summary.estimated ? ` · ${t("miniWindow.context.estimated")}` : ""}`}
        </span>
      </div>
      <div className="flex justify-between gap-3">
        <span>{t("chat.metrics.toolCalls")}</span>
        <span className="font-mono">{summary.toolCalls ?? unknown}</span>
      </div>
    </div>
  );
}

/** 用量标签页挂载时才订阅子任务，避免过程与结果页承担统计更新。 */
export function TaskUsageDetails({
  sessionId,
  taskId,
}: {
  sessionId: string;
  taskId?: string;
}) {
  const records = useUsageRecords(sessionId).filter(
    (record) => taskId != null && record.taskId === taskId,
  );
  return (
    <div className="space-y-1 text-[11px]">
      <UsageDetails records={records} />
      <OutputToolDetails records={records} />
    </div>
  );
}

/** 展示配置名称，不向统计面板暴露内部 Provider 实例 ID。 */
export function UsageModelLabel({ model }: { model: ModelRef }) {
  const providers = usePreferencesStore((state) => state.customProviders);
  const builtin = providerFromBuiltinId(model.providerId);
  const name =
    providers.find((provider) => provider.id === model.providerId)?.name ??
    (builtin ? getProvider(builtin).label : undefined);
  return (
    <>
      {name && name.trim().toLowerCase() !== model.modelId.trim().toLowerCase()
        ? `${name} / ${model.modelId}`
        : model.modelId}
    </>
  );
}
