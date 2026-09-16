/** 所有发送入口先记录请求，完成后保存回执；记录失败重试不再次投递。 */
import { channelOwnerId } from "@/modules/channels/identity";
import { ensureChannelSession } from "@/modules/channels/agentSession";
import {
  appendSessionDisplay,
  chats,
  seedMessages,
  seedSession,
} from "@/modules/ai/store/chatStore";
import { projectConversationDisplay } from "@/modules/ai/lib/conversation";
import {
  hasDeliveryIssue,
  projectDeliveries,
  setDeliveryPending,
  useDeliveryHistory,
} from "@/modules/channels/history";
import { readSession } from "@/modules/ai/lib/sessions";
import { ChannelError } from "@/modules/channels/types";
import type {
  ChannelSession,
  ChannelOutbound,
  ChannelDeliveryResult,
  ChannelDeliverySource,
} from "@/modules/channels/types";

export async function beginChannelSend(
  connection: ChannelSession,
  content: ChannelOutbound,
  send: (deliveryId: string) => Promise<ChannelDeliveryResult>,
  source: ChannelDeliverySource = "application",
  retryOf?: string,
): Promise<{ completed: Promise<ChannelDeliveryResult> }> {
  await ensureChannelSession(connection);
  const sessionId = connection.sessionId;
  const ownerId = await channelOwnerId(connection);
  if (!chats.has(sessionId) && !seedMessages.has(sessionId))
    await seedSession(sessionId);
  const messages = projectConversationDisplay(
    chats.get(sessionId)?.messages ?? seedMessages.get(sessionId) ?? [],
  );
  const id = crypto.randomUUID();
  setDeliveryPending(id, true);
  try {
    await appendSessionDisplay(
      sessionId,
      {
        role: "delivery",
        timestamp: new Date().toISOString(),
        content: {
          id,
          phase: "request",
          source,
          retryOf,
          target: connection.target,
          content,
          afterMessageId: messages[messages.length - 1]?.id,
        },
      },
      ownerId,
    );
  } catch (error) {
    setDeliveryPending(id, false);
    throw error;
  }
  const completed = (async () => {
    let result: ChannelDeliveryResult;
    try {
      result = await send(id);
    } catch {
      result = { status: "unknown", parts: [], reason: "interrupted" };
    }
    await appendSessionDisplay(
      sessionId,
      {
        role: "delivery",
        timestamp: new Date().toISOString(),
        content: {
          id,
          phase: "result",
          result,
          notification:
            result.status !== "accepted" ? { status: "error" } : undefined,
        },
      },
      ownerId,
    );
    return result;
  })().finally(() => setDeliveryPending(id, false));
  return { completed };
}

/** 只更新当前会话中明确指定的待处理通知，忽略不触发任何平台操作。 */
export async function dismissChannelDeliveries(
  connection: ChannelSession,
  ids: readonly string[],
  onDismiss?: (id: string) => void,
): Promise<void> {
  const entries = projectDeliveries(
    (await readSession(connection.sessionId)).messages,
  );
  const ownerId = await channelOwnerId(connection);
  for (const entry of entries) {
    if (
      !ids.includes(entry.id) ||
      !hasDeliveryIssue(entry, useDeliveryHistory.getState().pending[entry.id])
    )
      continue;
    await appendSessionDisplay(
      connection.sessionId,
      {
        role: "delivery",
        timestamp: new Date().toISOString(),
        content: {
          id: entry.id,
          phase: "notification",
          notification: { status: "ignored" },
        },
      },
      ownerId,
    );
    onDismiss?.(entry.id);
  }
}

/** 重试从已保存记录读取原内容，创建新发送卡片，不重跑模型或命令。 */
export async function retryChannelDelivery(
  connection: ChannelSession,
  id: string,
  send: (
    content: ChannelOutbound,
    deliveryId: string,
  ) => Promise<ChannelDeliveryResult>,
) {
  const entry = projectDeliveries(
    (await readSession(connection.sessionId)).messages,
  ).find((entry) => entry.id === id);
  if (
    !entry ||
    !hasDeliveryIssue(entry, useDeliveryHistory.getState().pending[id])
  )
    throw new ChannelError("configuration");
  return beginChannelSend(
    connection,
    entry.content,
    (deliveryId) => send(entry.content, deliveryId),
    "application",
    id,
  );
}
