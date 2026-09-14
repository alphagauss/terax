/** 应用主动发送先记录请求，完成后保存回执；记录失败重试不再次投递。 */
import { channelOwnerId } from "@/modules/channels/identity";
import { ensureChannelSession } from "@/modules/channels/agentSession";
import {
  appendSessionDisplay,
  chats,
  seedMessages,
  seedSession,
} from "@/modules/ai/store/chatStore";
import { projectConversationDisplay } from "@/modules/ai/lib/conversation";
import { setDeliveryPending } from "@/modules/channels/history";
import type {
  ChannelSession,
  ChannelOutbound,
  ChannelDeliveryResult,
} from "@/modules/channels/types";

export async function beginChannelSend(
  connection: ChannelSession,
  content: ChannelOutbound,
  send: () => Promise<ChannelDeliveryResult>,
): Promise<{ completed: Promise<void> }> {
  await ensureChannelSession(connection);
  const sessionId = connection.sessionId;
  const ownerId = await channelOwnerId(connection);
  if (!chats.has(sessionId) && !seedMessages.has(sessionId))
    await seedSession(sessionId);
  const messages = projectConversationDisplay(
    chats.get(sessionId)?.messages ?? seedMessages.get(sessionId) ?? [],
  );
  const id = crypto.randomUUID();
  await appendSessionDisplay(
    sessionId,
    {
      role: "delivery",
      timestamp: new Date().toISOString(),
      content: {
        id,
        phase: "request",
        target: connection.target,
        content,
        afterMessageId: messages[messages.length - 1]?.id,
      },
    },
    ownerId,
  );
  setDeliveryPending(id, true);
  const completed = (async () => {
    let result: ChannelDeliveryResult;
    try {
      result = await send();
    } catch {
      result = { status: "unknown", parts: [] };
    }
    await appendSessionDisplay(
      sessionId,
      {
        role: "delivery",
        timestamp: new Date().toISOString(),
        content: { id, phase: "result", result },
      },
      ownerId,
    );
  })().finally(() => setDeliveryPending(id, false));
  return { completed };
}
