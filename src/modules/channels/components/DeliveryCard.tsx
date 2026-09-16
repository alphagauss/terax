/** 展示通用投递结果；回复正文已在相邻消息中显示时只展示回执。 */
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  useDeliveryHistory,
  type DeliveryDisplay,
} from "@/modules/channels/history";

export function DeliveryCard({
  entry,
  compact = false,
}: {
  entry: DeliveryDisplay;
  compact?: boolean;
}) {
  const pending = useDeliveryHistory((state) => state.pending[entry.id]);
  const { t, i18n } = useTranslation("channels");
  const status = entry.result?.status ?? (pending ? "sending" : "unconfirmed");
  const uncertain = status === "unknown" || status === "unconfirmed";
  const failed = status === "failed" || status === "partial";
  return (
    <div
      className={cn(
        "rounded-md border p-3 text-[12px]",
        failed
          ? "border-destructive/40"
          : uncertain
            ? "border-amber-500/40"
            : "border-border",
      )}
      data-conversation-message-id={entry.id}
    >
      <div className="mb-2 flex justify-between gap-2 text-muted-foreground">
        <span>
          {t(`outbound.sources.${entry.source ?? "application"}`)} ·{" "}
          {entry.target.id}
        </span>
        <span
          className={cn(
            failed && "text-destructive",
            uncertain && "text-amber-600 dark:text-amber-400",
          )}
        >
          {t(`outbound.${status}`)}
        </span>
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
      {entry.result?.reason && (
        <p className="mt-2 text-muted-foreground">
          {t(`outbound.reasons.${entry.result.reason}`)}
        </p>
      )}
      {entry.result &&
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
      <div className="mt-2 text-[10px] text-muted-foreground">
        {new Date(entry.timestamp).toLocaleString(i18n.language)}
      </div>
    </div>
  );
}
