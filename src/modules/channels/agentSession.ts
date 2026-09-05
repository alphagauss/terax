/**
 * 本文件将连接消息接入现有 AI 会话运行链。
 * 不修改活动聊天、输入草稿或全局模型权限；结果只在本轮持久化完成后交给适配器。
 */

import type { SteeringReceipt } from "@/modules/ai/lib/turnInbox";
import i18n from "@/i18n";
import { MAIN_AGENT, snapshotAgent } from "@/modules/ai/lib/agents";
import { commitSession } from "@/modules/ai/lib/sessions";
import {
  getOrCreateChat,
  startChatMessage,
  steerChatMessage,
} from "@/modules/ai/store/chatRuntime";
import {
  chats,
  getAgentMetaForSession,
  persistedMessageCounts,
  seedMessages,
  seedSession,
  sessionMetadata,
  stopSession,
  useChatStore,
} from "@/modules/ai/store/chatStore";
import {
  type ChannelConnection,
  ChannelError,
  type ChannelInbound,
} from "@/modules/channels/types";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { prepareDefaultWorkspaceRoot } from "@/modules/workspace";
import type { UIMessage } from "ai";

/** 准备固定 Channel 会话，现有会话只恢复，不抢占桌面草稿。 */
export async function ensureChannelSession(
  connection: ChannelConnection,
): Promise<void> {
  const state = useChatStore.getState();
  const existing = state.sessions.find(
    (item) => item.id === connection.sessionId,
  );
  if (existing) {
    if (
      existing.channelId !== connection.id ||
      existing.environmentKey !== "local"
    )
      throw new ChannelError("storage");
    if (!chats.has(existing.id) && !seedMessages.has(existing.id))
      await seedSession(existing.id);
    return;
  }
  const cwd = await prepareDefaultWorkspaceRoot();
  const now = Date.now();
  const metadata = {
    title: connection.name,
    channelId: connection.id,
    agent: snapshotAgent(MAIN_AGENT),
  };
  const meta = await commitSession({
    id: connection.sessionId,
    createdAt: now,
    updatedAt: now,
    environmentKey: "local",
    cwd,
    metadata,
    messages: [],
  });
  sessionMetadata.set(meta.id, metadata);
  seedMessages.set(meta.id, []);
  persistedMessageCounts.set(meta.id, 0);
  useChatStore.setState((current) => ({
    sessions: [meta, ...current.sessions.filter((item) => item.id !== meta.id)],
  }));
}

/** 只提取本轮最后一步的 Assistant 可见正文，不回传推理、工具或内部事件。 */
export function channelReplyText(messages: readonly UIMessage[]): string {
  let assistant: UIMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant") {
      assistant = messages[index];
      break;
    }
  }
  if (!assistant) return "";
  let lastStep = 0;
  for (let index = 0; index < assistant.parts.length; index++) {
    if (assistant.parts[index].type === "step-start") lastStep = index;
  }
  return assistant.parts
    .slice(lastStep)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

/** 执行一个外部输入，并等待既有 Bridge 完成提交与释放运行锁。 */
export async function runChannelTurn(
  connection: ChannelConnection,
  message: ChannelInbound,
  signal: AbortSignal,
  ready: (steer: (message: ChannelInbound) => SteeringReceipt | null) => void,
): Promise<string | null> {
  signal.throwIfAborted();
  const model = usePreferencesStore.getState().defaultModel;
  if (!model) throw new ChannelError("model");
  await ensureChannelSession(connection);
  signal.throwIfAborted();
  const chat = getOrCreateChat(connection.sessionId);
  if (
    getAgentMetaForSession(useChatStore.getState(), connection.sessionId)
      .commitError
  ) {
    // 重连只补交此前未保存的终态，绝不重新执行上一轮 Agent。
    try {
      await useChatStore
        .getState()
        .commitMessages(connection.sessionId, chat.messages);
    } catch {
      throw new ChannelError("storage");
    }
  }
  signal.throwIfAborted();
  const offset = chat.messages.length;
  const accepted = await startChatMessage(
    connection.sessionId,
    {
      role: "user",
      parts: [{ type: "text", text: message.text }],
      metadata: { createdAt: message.receivedAt },
    },
    { id: connection.id, model },
  );
  if (!accepted) throw new ChannelError("model");
  ready((input) =>
    steerChatMessage(
      connection.sessionId,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: input.text }],
        metadata: { createdAt: input.receivedAt },
      },
      connection.id,
    ),
  );
  let cleanup = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        void stopSession(connection.sessionId).catch(reject);
      };
      const check = () => {
        const state = useChatStore.getState();
        if (getAgentMetaForSession(state, connection.sessionId).commitError) {
          reject(new ChannelError("storage"));
          return;
        }
        if (!state.runLockSessionIds[connection.sessionId]) {
          resolve();
        }
      };
      const unsubscribe = useChatStore.subscribe(check);
      signal.addEventListener("abort", stop, { once: true });
      cleanup = () => {
        unsubscribe();
        signal.removeEventListener("abort", stop);
      };
      check();
      if (signal.aborted) stop();
    });
    signal.throwIfAborted();
    if (
      getAgentMetaForSession(useChatStore.getState(), connection.sessionId)
        .status === "error"
    )
      throw new ChannelError("agent");
    if (
      getAgentMetaForSession(useChatStore.getState(), connection.sessionId)
        .cancelled
    )
      return null;
    return (
      channelReplyText(chat.messages.slice(offset)) ||
      i18n.t("channels:emptyReply")
    );
  } finally {
    cleanup();
  }
}
