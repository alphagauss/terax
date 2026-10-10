/** 展示通用投递结果；已有回复正文时以内联状态展示，不再嵌套独立卡片。 */
import { useChatDisplayStore } from "@/modules/ai/hooks/chatDisplay";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/controls/button";
import {
  useDeliveryHistory,
  type DeliveryDisplay,
  hasDeliveryIssue,
} from "@/modules/channels/history";

export function DeliveryCard({
  entry,
  compact = false,
  onIgnore,
  onRetry,
  busy = false,
  canRetry = false,
}: {
  entry: DeliveryDisplay;
  compact?: boolean;
  onIgnore?: () => void;
  onRetry?: () => void;
  busy?: boolean;
  canRetry?: boolean;
}) {
  const pending = useChatDisplayStore(
    useDeliveryHistory,
    (state) => state.pending[entry.id],
  );
  const { t, i18n } = useTranslation("channels");
  const handled =
    entry.notification?.status === "ignored" ||
    entry.notification?.status === "retried";
  const status = handled
    ? entry.notification?.status
    : (entry.result?.status ?? (pending ? "sending" : "unconfirmed"));
  const issue = hasDeliveryIssue(entry, pending);
  const uncertain = status === "unknown" || status === "unconfirmed";
  const failed = status === "failed" || status === "partial";
  return (
    <div
      className={cn(
        compact ? "mt-2 text-[12px]" : "rounded-md border p-3 text-[12px]",
        !compact &&
          (failed
            ? "border-destructive/40"
            : uncertain
              ? "border-amber-500/40"
              : "border-border"),
      )}
      data-conversation-message-id={entry.id}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 text-muted-foreground",
          !compact && "mb-2",
        )}
      >
        {!compact && (
          <span>
            {t(`outbound.sources.${entry.source}`)} · {entry.target.id}
          </span>
        )}
        <span
          className={cn(
            failed && "text-destructive",
            uncertain && "text-amber-600 dark:text-amber-400",
          )}
        >
          {t(`outbound.${status}`)}
        </span>
        {compact && (
          <time
            className="text-[10px]"
            dateTime={new Date(entry.timestamp).toISOString()}
          >
            {new Date(entry.timestamp).toLocaleString(i18n.language)}
          </time>
        )}
      </div>
      {!compact && entry.content.text && (
        <p className="whitespace-pre-wrap break-words">{entry.content.text}</p>
      )}
      {!compact && Boolean(entry.content.attachments?.length) && (
        <p className="mt-1 whitespace-pre-wrap break-all font-mono text-muted-foreground">
          {entry.content.attachments?.map((file) => file.path).join("\n")}
        </p>
      )}
      {uncertain && (
        <p className="mt-2 text-amber-600 dark:text-amber-400">
          {t("outbound.unknownHelp")}
        </p>
      )}
      {!handled && entry.result?.reason && (
        <p className="mt-2 text-muted-foreground">
          {t(`outbound.reasons.${entry.result.reason}`)}
        </p>
      )}
      {!handled &&
        entry.result &&
        entry.result.status !== "accepted" &&
        (entry.result.total ?? entry.result.parts.length) > 1 && (
          <div className="mt-2 text-muted-foreground">
            {t("outbound.parts", {
              accepted: entry.result.parts.filter(
                (part) => part.status === "accepted",
              ).length,
              failed: entry.result.parts.filter(
                (part) => part.status === "failed",
              ).length,
              unknown: entry.result.parts.filter(
                (part) => part.status === "unknown",
              ).length,
              unsent: Math.max(
                0,
                (entry.result.total ?? entry.result.parts.length) -
                  entry.result.parts.length,
              ),
            })}
          </div>
        )}
      {!compact && (
        <div className="mt-2 text-[10px] text-muted-foreground">
          {new Date(entry.timestamp).toLocaleString(i18n.language)}
        </div>
      )}
      {issue && onIgnore && onRetry && (
        <div className="mt-2 flex items-center justify-end gap-2">
          {(status === "unknown" ||
            status === "unconfirmed" ||
            status === "partial") && (
            <span className="mr-auto text-[10px] text-muted-foreground">
              {t("outbound.retryWarning")}
            </span>
          )}
          <Button variant="ghost" size="xs" disabled={busy} onClick={onIgnore}>
            {t("outbound.ignore")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={busy || !canRetry}
            onClick={onRetry}
          >
            {t("outbound.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
