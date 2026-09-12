/** 将通用附件事实投影为 Agent 输入，不包含平台令牌、CDN 地址或密钥。 */
import type { ChannelInbound } from "@/modules/channels/types";
import i18n from "@/i18n";

export function channelInputText(message: ChannelInbound): string {
  if (!message.attachments.length) return message.text;
  return [
    message.text,
    JSON.stringify({ attachments: message.attachments }),
    i18n.t("channels:attachmentInstruction"),
  ]
    .filter(Boolean)
    .join("\n\n");
}
