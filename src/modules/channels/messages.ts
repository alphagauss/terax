/** 将通用 Channel 入站事实投影为 Agent 用户消息，不包含平台凭据或 CDN 地址。 */
import type { UIMessage } from "ai";
import type { ChannelInbound } from "@/modules/channels/types";
import i18n from "@/i18n";

export function channelInputText(message: ChannelInbound): string {
  const text =
    message.target.kind === "group"
      ? `[Sender: ${JSON.stringify(message.senderId)}]\n${message.text}`
      : message.text;
  if (!message.attachments.length) return text;
  const images = message.attachments.filter(
    (attachment) => attachment.kind === "image",
  );
  const imagePaths = images.flatMap((attachment) =>
    attachment.status === "ready" ? [attachment.path] : [],
  );
  const failedImages = images
    .filter((attachment) => attachment.status === "failed")
    .map((attachment) => attachment.name);
  const references = message.attachments
    .filter((attachment) => attachment.kind !== "image")
    .map((attachment) =>
      attachment.status === "ready"
        ? `[Attachment: name=${attachment.name}; kind=${attachment.kind}; path=${attachment.path}; status=ready]`
        : `[Attachment: name=${attachment.name}; kind=${attachment.kind}; status=failed]`,
    );
  return [
    text,
    images.length
      ? i18n.t("channels:imageAttachmentSummary", {
          count: images.length,
          paths: imagePaths.join(", ") || "(none)",
          failed: failedImages.join(", ") || "(none)",
        })
      : "",
    references.join("\n"),
    i18n.t("channels:attachmentInstruction"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 一条平台消息只生成一条用户消息，图片以 AI SDK 通用 file part 传入模型。 */
export function channelUserMessage(message: ChannelInbound): UIMessage {
  const text = channelInputText(message);
  return {
    id: message.id,
    role: "user",
    parts: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...(message.modelMedia ?? []),
    ],
    metadata: { createdAt: message.receivedAt },
  };
}
