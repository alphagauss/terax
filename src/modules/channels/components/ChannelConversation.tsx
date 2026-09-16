/** 消息通道订阅已有会话实例及展示记录，不读取独立历史副本，也不启动 Agent。 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat, type Chat, type UIMessage } from "@ai-sdk/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/controls/button";
import { requestChannels } from "@/modules/channels/client";
import { DeliveryCard } from "@/modules/channels/components/DeliveryCard";
import {
  EMPTY_DELIVERIES,
  hasDeliveryIssue,
  useDeliveryHistory,
  type DeliveryDisplay,
} from "@/modules/channels/history";
import { EMPTY_COMMANDS, useCommandStore } from "@/modules/ai/commands/store";
import {
  messageMetadata,
  projectConversationDisplay,
} from "@/modules/ai/lib/conversation";
import { STREAM_RENDER_INTERVAL_MS } from "@/modules/ai/lib/chatRendering";

type HistoryEntry = {
  id: string;
  timestamp: number;
  text: string;
  role: string;
  delivery?: DeliveryDisplay;
  failure?: string;
};
export function ChannelConversation({
  chat,
  sessionId,
  connectionId: id,
  canRetry,
  onError,
}: {
  chat: Chat<UIMessage>;
  sessionId: string;
  connectionId: string;
  canRetry: boolean;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation("channels");
  const { messages } = useChat<UIMessage>({
    chat,
    experimental_throttle: STREAM_RENDER_INTERVAL_MS,
  });
  const commands = useCommandStore(
    (state) => state.sessions[sessionId] ?? EMPTY_COMMANDS,
  );
  const deliveries = useDeliveryHistory(
    (state) => state.sessions[sessionId] ?? EMPTY_DELIVERIES,
  );
  const sending = useDeliveryHistory((state) => state.pending);
  const [handling, setHandling] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const entries = useMemo(() => {
    const entries: HistoryEntry[] = projectConversationDisplay(messages)
      .filter((message) => !messageMetadata(message).commandId)
      .map((message) => ({
        id: message.id,
        // 未落盘的流式消息留在末尾，不能用零时间把新回复排到历史开头。
        timestamp:
          messageMetadata(message).createdAt ?? Number.POSITIVE_INFINITY,
        role: message.role,
        failure: messageMetadata(message).runFailure?.error,
        text: messageMetadata(message).runFailure
          ? t("ai:chat.runFailed", {
              error: messageMetadata(message).runFailure?.error,
            })
          : message.parts
              .flatMap((part) =>
                part.type === "text" && part.text.trim() ? [part.text] : [],
              )
              .join("\n")
              .trim(),
      }))
      .filter((entry) => entry.text);
    for (const command of commands)
      entries.push({
        id: command.id,
        timestamp: command.timestamp,
        role: "command",
        text: [command.input, command.result?.text].filter(Boolean).join("\n"),
      });
    const replies = new Map(entries.map((entry) => [entry.id, entry]));
    for (const delivery of deliveries) {
      const reply = delivery.afterMessageId
        ? replies.get(delivery.afterMessageId)
        : undefined;
      // 自动回复跟随原消息；人工发送和重发独立保留。
      const automatic = delivery.source !== "application";
      if (automatic && delivery.afterMessageId && !reply) continue;
      if (
        automatic &&
        reply &&
        !reply.delivery &&
        ((delivery.source === "agent" && reply.role === "assistant") ||
          (delivery.source === "system" && reply.failure))
      ) {
        reply.delivery = delivery;
        continue;
      }
      entries.push({
        id: delivery.id,
        timestamp: delivery.timestamp,
        role: "delivery",
        text: "",
        delivery,
      });
    }
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  }, [messages, commands, deliveries, t]);
  const issues = entries.flatMap((entry) =>
    entry.delivery &&
    hasDeliveryIssue(entry.delivery, sending[entry.delivery.id])
      ? [entry.delivery]
      : [],
  );
  const handleIssue = async (
    action: "dismiss-deliveries" | "retry-delivery",
    ids: string[],
  ) => {
    if (handling) return;
    setHandling(true);
    onError("");
    try {
      await requestChannels(
        action === "dismiss-deliveries"
          ? { action, id, sessionId, deliveryIds: ids }
          : { action, id, sessionId, deliveryId: ids[0] },
      );
    } catch {
      onError(t("outbound.handleFailed"));
    } finally {
      setHandling(false);
    }
  };
  const deliveryCard = (entry: DeliveryDisplay, compact = false) => (
    <DeliveryCard
      key={entry.id}
      entry={entry}
      compact={compact}
      busy={handling}
      canRetry={canRetry}
      onIgnore={() => void handleIssue("dismiss-deliveries", [entry.id])}
      onRetry={() => void handleIssue("retry-delivery", [entry.id])}
    />
  );
  useLayoutEffect(() => {
    if (entries.length && scroll.current && follow.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [entries]);
  return (
    <>
      {issues.length > 0 && (
        <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
          <details className="min-w-0 flex-1 text-amber-600 dark:text-amber-400">
            <summary className="cursor-pointer">
              {t("outbound.issues", { count: issues.length })}
            </summary>
            {issues.map((entry) => (
              <Button
                key={entry.id}
                size="xs"
                variant="ghost"
                className="mt-1 w-full justify-start"
                onClick={() => {
                  follow.current = false;
                  scroll.current
                    ?.querySelector(
                      `[data-conversation-message-id="${entry.id}"]`,
                    )
                    ?.scrollIntoView({ block: "center" });
                }}
              >
                <span className="truncate">
                  {entry.content.text ||
                    entry.content.attachments
                      ?.map((file) => file.path)
                      .join(", ") ||
                    t("outbound.viewIssue")}
                </span>
              </Button>
            ))}
          </details>
          <Button
            size="xs"
            variant="ghost"
            disabled={handling}
            onClick={() =>
              void handleIssue(
                "dismiss-deliveries",
                issues.map((entry) => entry.id),
              )
            }
          >
            {t("outbound.ignoreAll")}
          </Button>
        </div>
      )}
      <div
        ref={scroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            48;
        }}
        className="app-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      >
        {entries.map((entry) =>
          entry.delivery && entry.role === "delivery" ? (
            deliveryCard(entry.delivery)
          ) : (
            <div key={entry.id} className="rounded-md bg-secondary p-3">
              <div className="mb-1 text-muted-foreground">
                {t(`outbound.roles.${entry.role}`)}
              </div>
              <p
                className={`whitespace-pre-wrap break-words${entry.failure ? " text-destructive" : ""}`}
              >
                {entry.text}
              </p>
              {entry.delivery && deliveryCard(entry.delivery, true)}
            </div>
          ),
        )}
      </div>
    </>
  );
}
