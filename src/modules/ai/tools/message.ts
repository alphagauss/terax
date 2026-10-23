/** Channel 消息工具只提交内容，投递目标与文件读取能力由当前运行注入。 */
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/modules/ai/tools/context";

export const messageInputSchema = z
  .object({
    text: z.string().max(32000).optional(),
    attachments: z
      .array(
        z.object({
          path: z.string().min(1),
          presentation: z
            .enum(["file", "image", "video", "audio"])
            .default("file"),
        }),
      )
      .max(8)
      .optional(),
  })
  .refine((value) => Boolean(value.text?.trim() || value.attachments?.length), {
    message: "Provide text or at least one attachment",
  });

/** 捕获本次工具构建所属运行的发送能力，迟到的调用不能借用下一轮目标。 */
export function buildMessageTools(ctx: ToolContext) {
  const send = ctx.getMessageSender?.();
  return {
    message: tool({
      description:
        "Send text or existing files to the current channel conversation. To deliver a file, put its absolute path or path relative to the session cwd in attachments; writing a path in your reply does not send it. Use the final reply for ordinary text and avoid sending the same text twice. Leave presentation as file unless you intend image, video, or audio presentation. Check the returned status and parts; report only confirmed accepted parts as delivered, not that the recipient read them. If a delivery status is unknown, do not resend that part automatically: the platform may already have accepted it.",
      inputSchema: messageInputSchema,
      execute: async (input, { abortSignal }) => {
        if (!send) return { error: "Channel delivery is unavailable" };
        return send(input, abortSignal);
      },
    }),
  };
}
