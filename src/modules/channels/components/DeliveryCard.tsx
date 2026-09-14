/** 人工发送只展示原文、路径和平台投递结果，不提供 Agent 操作。 */
import { useTranslation } from "react-i18next";
import {
  useDeliveryHistory,
  type DeliveryDisplay,
} from "@/modules/channels/history";

export function DeliveryCard({ entry }: { entry: DeliveryDisplay }) {
  const pending = useDeliveryHistory((state) => state.pending[entry.id]);
  const { t, i18n } = useTranslation("channels");
  return (
    <div
      className="rounded-md border border-border p-3 text-[12px]"
      data-conversation-message-id={entry.id}
    >
      <div className="mb-2 flex justify-between gap-2 text-muted-foreground">
        <span>
          {t("outbound.label")} · {entry.target.id}
        </span>
        <span>
          {t(
            `outbound.${entry.result?.status ?? (pending ? "sending" : "unconfirmed")}`,
          )}
        </span>
      </div>
      {entry.content.text && (
        <p className="whitespace-pre-wrap break-words">{entry.content.text}</p>
      )}
      {Boolean(entry.content.attachments?.length) && (
        <p className="mt-1 whitespace-pre-wrap break-all font-mono text-muted-foreground">
          {entry.content.attachments?.map((file) => file.path).join("\n")}
        </p>
      )}
      {entry.result && entry.result.status !== "accepted" && (
        <div className="mt-2 text-muted-foreground">
          {t("outbound.parts", {
            count: entry.result.parts.filter(
              (part) => part.status === "accepted",
            ).length,
          })}
        </div>
      )}
      <div className="mt-2 text-[10px] text-muted-foreground">
        {new Date(entry.timestamp).toLocaleString(i18n.language)}
      </div>
    </div>
  );
}
