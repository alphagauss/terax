/** 随主 Agent 调用完成更新上下文用量与缓存复用状态；压缩请求不覆盖主请求统计。 */

import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import { cn } from "@/lib/utils";
import {
  formatTokens,
  SessionUsageDetails,
  UsageModelLabel,
  useUsageRecords,
} from "@/modules/ai/components/UsageDetails";
import { getModelContextWindow } from "@/modules/ai/config";
import { parseExternalAgentBinding } from "@/modules/ai/external-agents/runtime";
import { estimateUiMessageTokens } from "@/modules/ai/lib/chatRendering";
import { estimateTokens } from "@/modules/ai/lib/usage";
import { analyzeCacheUsage } from "@/modules/ai/lib/usageAnalysis";
import { sessionMetadata, useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { UIMessage } from "ai";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

export function ContextIndicator({
  sessionId,
  isBusy,
  messages,
}: {
  sessionId: string | null;
  isBusy: boolean;
  messages: UIMessage[];
}) {
  const { t } = useTranslation("ai");
  const selectedModel = useChatStore((state) => state.selectedModel);
  const draftSessionId = useChatStore((state) => state.draftSessionId);
  const providerModels = usePreferencesStore((state) => state.providerModels);
  const records = useUsageRecords(sessionId ?? "");
  const cacheAnalysis = useMemo(() => analyzeCacheUsage(records), [records]);
  const cacheIncident =
    cacheAnalysis.incidents[cacheAnalysis.incidents.length - 1];
  const cacheNoticeKey =
    cacheAnalysis.status === "suspected"
      ? "miniWindow.context.cacheAnomaly"
      : cacheAnalysis.status === "recovered"
        ? "miniWindow.context.cacheRecovered"
        : "miniWindow.context.cacheAnomalyHistory";
  const latest = [...records]
    .reverse()
    .find((record) => !record.taskId && !record.purpose);
  const estimateRef = useRef({ id: sessionId, tokens: 0 });
  const estimate = useMemo(() => {
    if (latest) return 0;
    if (
      isBusy &&
      estimateRef.current.id === sessionId &&
      estimateRef.current.tokens > 0
    )
      return estimateRef.current.tokens;
    const system = sessionId
      ? sessionMetadata.get(sessionId)?.systemPrompt
      : undefined;
    const tokens =
      estimateUiMessageTokens(messages) +
      (typeof system === "string" ? estimateTokens(system) : 0);
    estimateRef.current = { id: sessionId, tokens };
    return tokens;
  }, [messages, isBusy, sessionId, latest]);
  const model = latest?.model ?? selectedModel;
  const used = latest?.values.inputTokens ?? estimate;
  const max =
    latest?.contextWindow ?? getModelContextWindow(model, providerModels);
  const approximate = !latest || latest.estimated.includes("inputTokens");
  if (
    sessionId === draftSessionId ||
    parseExternalAgentBinding(
      sessionId ? sessionMetadata.get(sessionId) : undefined,
    )
  )
    return null;
  return (
    <Context usedTokens={used} maxTokens={max}>
      <ContextTrigger
        className={cn(
          "h-6 shrink-0 gap-1 px-0 text-[10.5px]",
          cacheIncident &&
            "relative after:absolute after:right-0 after:top-0.5 after:size-1.5 after:rounded-full after:bg-warning",
        )}
        aria-label={`${t("miniWindow.context.usage")}: ${approximate ? "≈" : ""}${formatTokens(used)} / ${formatTokens(max)}${approximate ? ` · ${t("miniWindow.context.estimated")}` : ""}${cacheIncident ? ` · ${t(cacheNoticeKey)}` : ""}`}
      />
      <ContextContent className="w-80 max-h-[70vh] overflow-y-auto text-[11px]">
        <ContextContentHeader />
        <ContextContentBody className="space-y-3">
          <div className="break-all text-muted-foreground">
            {model ? (
              <UsageModelLabel model={model} />
            ) : (
              t("statusBar.noModels")
            )}
          </div>
          {cacheIncident && (
            <div className="rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5 text-muted-foreground">
              <p className="font-medium text-warning">{t(cacheNoticeKey)}</p>
              <p className="mt-1">
                {t("miniWindow.context.cacheAnomalyDetails", {
                  actual: formatTokens(cacheIncident.cacheReadTokens),
                  expected: formatTokens(cacheIncident.expectedTokens),
                  coverage: `${(cacheIncident.prefixReuseCoverage * 100).toFixed(0)}%`,
                })}
              </p>
              <p>
                {t("miniWindow.context.cacheAnomalyCount", {
                  count: cacheAnalysis.incidents.length,
                })}
              </p>
            </div>
          )}
          {approximate && (
            <p className="text-muted-foreground">
              {t("miniWindow.context.footerApprox")}
            </p>
          )}
          {latest ? (
            <SessionUsageDetails context={latest} records={records} />
          ) : (
            <p className="text-muted-foreground">
              {t("miniWindow.context.noUsage")}
            </p>
          )}
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}
