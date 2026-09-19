/** 随主 Agent 调用完成更新上下文用量；压缩请求不覆盖主请求的统计。 */

import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import {
  formatTokens,
  UsageDetails,
  UsageModelLabel,
  useUsageRecords,
} from "@/modules/ai/components/UsageDetails";
import { getModelContextWindow } from "@/modules/ai/config";
import { parseExternalAgentBinding } from "@/modules/ai/external-agents/runtime";
import { estimateUiMessageTokens } from "@/modules/ai/lib/chatRendering";
import { estimateTokens } from "@/modules/ai/lib/usage";
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
  const draftExternalAgentId = useChatStore(
    (state) => state.draftExternalAgentId,
  );
  const draftSessionId = useChatStore((state) => state.draftSessionId);
  const providerModels = usePreferencesStore((state) => state.providerModels);
  const records = useUsageRecords(sessionId ?? "");
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
    parseExternalAgentBinding(
      sessionId ? sessionMetadata.get(sessionId) : undefined,
    ) ||
    (sessionId === draftSessionId && draftExternalAgentId)
  )
    return null;
  return (
    <Context usedTokens={used} maxTokens={max}>
      <ContextTrigger
        className="h-6 shrink-0 gap-1 px-0 text-[10.5px]"
        aria-label={`${t("miniWindow.context.usage")}: ${approximate ? "≈" : ""}${formatTokens(used)} / ${formatTokens(max)}${approximate ? ` · ${t("miniWindow.context.estimated")}` : ""}`}
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
          {approximate && (
            <p className="text-muted-foreground">
              {t("miniWindow.context.footerApprox")}
            </p>
          )}
          {latest ? (
            <UsageDetails records={[latest]} />
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
