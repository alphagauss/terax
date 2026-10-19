/** 压缩后估算有效上下文，主调用完成后使用实际用量；预估不覆盖调用统计或缓存诊断。 */

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
import {
  convertToAgentModelMessages,
  expandConversationMessages,
  messageMetadata,
} from "@/modules/ai/lib/conversation";
import { estimateMessageTokens, estimateTokens } from "@/modules/ai/lib/usage";
import {
  analyzeSessionCacheUsage,
  type CacheAnalysis,
} from "@/modules/ai/lib/usageAnalysis";
import { sessionMetadata, useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { UIMessage } from "ai";
import { useEffect, useState, useMemo, useRef } from "react";
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
  const cacheWarnings = useMemo(
    () =>
      analyzeSessionCacheUsage(records).filter(
        (analysis) => analysis.incidents.length,
      ),
    [records],
  );
  const cacheNoticeKey = cacheWarnings.some(
    (analysis) => analysis.status === "suspected",
  )
    ? "miniWindow.context.cacheAnomaly"
    : cacheWarnings.some((analysis) => analysis.status === "recovered")
      ? "miniWindow.context.cacheRecovered"
      : "miniWindow.context.cacheAnomalyHistory";
  const latest = [...records]
    .reverse()
    .find((record) => !record.taskId && !record.purpose);
  const recordedOverhead = [...records]
    .reverse()
    .find(
      (record) =>
        !record.taskId && record.context?.overheadTokens !== undefined,
    )?.context?.overheadTokens;
  const checkpoint = useMemo(
    () =>
      expandConversationMessages(messages)
        .map((message) => messageMetadata(message).compaction)
        .reverse()
        .find(Boolean),
    [messages],
  );
  const needsEstimate = Boolean(
    checkpoint && latest?.context?.compactionId !== checkpoint.id,
  );
  const [compactedEstimate, setCompactedEstimate] = useState<{
    sessionId: string | null;
    checkpointId: string;
    tokens: number;
  }>();
  useEffect(() => {
    if (
      !needsEstimate ||
      !checkpoint ||
      (compactedEstimate?.sessionId === sessionId &&
        compactedEstimate.checkpointId === checkpoint.id)
    )
      return;
    let cancelled = false;
    void convertToAgentModelMessages(messages).then((modelMessages) => {
      if (cancelled) return;
      const system = sessionId
        ? sessionMetadata.get(sessionId)?.systemPrompt
        : undefined;
      const overhead =
        recordedOverhead ??
        estimateTokens(typeof system === "string" ? system : "");
      setCompactedEstimate({
        sessionId,
        checkpointId: checkpoint.id,
        tokens: overhead + estimateMessageTokens(modelMessages),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    needsEstimate,
    checkpoint,
    messages,
    sessionId,
    recordedOverhead,
    compactedEstimate,
  ]);
  const postCompaction =
    needsEstimate &&
    compactedEstimate?.sessionId === sessionId &&
    compactedEstimate.checkpointId === checkpoint?.id
      ? compactedEstimate.tokens
      : undefined;
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
  const used = postCompaction ?? latest?.values.inputTokens ?? estimate;
  const max =
    latest?.contextWindow ?? getModelContextWindow(model, providerModels);
  const approximate =
    postCompaction !== undefined ||
    !latest ||
    latest.estimated.includes("inputTokens");
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
          approximate && "before:content-['≈']",
          cacheWarnings.length > 0 &&
            "relative after:absolute after:right-0 after:top-0.5 after:size-1.5 after:rounded-full after:bg-warning",
        )}
        aria-label={`${t("miniWindow.context.usage")}: ${approximate ? "≈" : ""}${formatTokens(used)} / ${formatTokens(max)}${approximate ? ` · ${t("miniWindow.context.estimated")}` : ""}${cacheWarnings.length ? ` · ${t(cacheNoticeKey)}` : ""}`}
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
          {cacheWarnings.map((analysis) => (
            <CacheWarning
              key={analysis.incidents[0].taskId ?? "main"}
              analysis={analysis}
              sessionId={sessionId ?? ""}
            />
          ))}
          {approximate && (
            <p className="text-muted-foreground">
              {t(
                postCompaction !== undefined
                  ? "miniWindow.context.compactedEstimate"
                  : "miniWindow.context.footerApprox",
              )}
            </p>
          )}
          {latest ? (
            <>
              {postCompaction !== undefined && (
                <p className="text-muted-foreground">
                  {t("miniWindow.context.lastCall")}
                </p>
              )}
              <SessionUsageDetails context={latest} records={records} />
            </>
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

/** 缓存异常共用上下文浮窗，保留定位原始会话所需的调用身份。 */
function CacheWarning({
  analysis,
  sessionId,
}: {
  analysis: CacheAnalysis;
  sessionId: string;
}) {
  const { t } = useTranslation("ai");
  const incident = analysis.incidents[analysis.incidents.length - 1];
  const notice =
    analysis.status === "suspected"
      ? "cacheAnomaly"
      : analysis.status === "recovered"
        ? "cacheRecovered"
        : "cacheAnomalyHistory";
  return (
    <div className="rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5 text-muted-foreground">
      <p className="font-medium text-warning">
        {t(`miniWindow.context.${notice}`)}
      </p>
      <p className="mt-1">
        {t("miniWindow.context.cacheAnomalyDetails", {
          actual: formatTokens(incident.cacheReadTokens),
          expected: formatTokens(incident.expectedTokens),
          coverage: `${(incident.prefixReuseCoverage * 100).toFixed(0)}%`,
        })}
      </p>
      <p>
        {t(
          incident.taskId
            ? "miniWindow.context.cacheSubagent"
            : "miniWindow.context.cacheMainAgent",
        )}
        {incident.taskId ? `: ${incident.taskId}` : ""}
      </p>
      <details className="mt-1 break-all">
        <summary className="cursor-pointer">
          {t("miniWindow.context.cacheAnomalyCount", {
            count: analysis.incidents.length,
          })}
        </summary>
        <p>
          {t("miniWindow.context.cacheSessionId")}: {sessionId}
        </p>
        {analysis.incidents.map((item) => (
          <div key={item.currentCallId} className="mt-1 font-mono text-[10px]">
            <p>
              {t("miniWindow.context.cacheTurnId")}: {item.turnId}
            </p>
            {item.runId && (
              <p>
                {t("miniWindow.context.cacheRunId")}: {item.runId}
              </p>
            )}
            <p>
              {t("miniWindow.context.cachePreviousCallId")}:{" "}
              {item.previousCallId}
            </p>
            <p>
              {t("miniWindow.context.cacheCurrentCallId")}: {item.currentCallId}
            </p>
          </div>
        ))}
      </details>
    </div>
  );
}
