/**
 * 本文件将连接消息接入现有 AI 会话运行链。
 * 不修改活动聊天、输入草稿或全局模型权限；最终回复只在本轮持久化完成后交给投递出口。
 */

import { submitSessionCommand } from "@/modules/ai/commands/runtime";
import { parseCommand } from "@/modules/ai/commands/registry";
import { isModelRefAvailable } from "@/modules/ai/config";
import {
  channelModelUsageId,
  getModelUsage,
  resolveModelUsage,
} from "@/modules/ai/lib/modelUsage";
import type { SteeringReceipt } from "@/modules/ai/lib/turnInbox";
import { CHANNEL_AGENT, snapshotAgent } from "@/modules/ai/lib/agents";
import { commitSession } from "@/modules/ai/lib/sessions";
import {
  loadChat,
  startChatMessage,
  steerChatMessage,
} from "@/modules/ai/store/chatRuntime";
import {
  getAgentMetaForSession,
  stopSession,
  useChatStore,
} from "@/modules/ai/store/chatStore";
import {
  type ChannelConnection,
  ChannelError,
  type ChannelInbound,
} from "@/modules/channels/types";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { prepareChannelWorkspace } from "@/modules/channels/workspace";
import { channelUserMessage } from "@/modules/channels/messages";
import type { UIMessage } from "ai";

/** 准备固定 Channel 会话，现有会话只恢复，不抢占桌面草稿。 */
export async function ensureChannelSession(
  connection: ChannelConnection,
): Promise<void> {
  const cwd = await prepareChannelWorkspace(connection);
  const state = useChatStore.getState();
  const existing = state.sessions.find(
    (item) => item.id === connection.sessionId,
  );
  if (existing) {
    if (
      existing.channelId !== connection.id ||
      existing.environmentKey !== "local" ||
      existing.cwd !== cwd
    )
      throw new ChannelError("storage");
    return;
  }
  const now = Date.now();
  const metadata = {
    title: connection.name,
    channelId: connection.id,
    agent: snapshotAgent(CHANNEL_AGENT),
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

/** 忙碌时只接收即时命令，其余输入继续沿用连接队列。 */
export async function runChannelCommand(
  connection: ChannelConnection,
  message: ChannelInbound,
  signal: AbortSignal,
): Promise<string | null> {
  const command = parseCommand(message.text);
  return command && command.definition?.scheduling !== "idle"
    ? runChannelTurn(connection, message, signal, () => {})
    : null;
}

/** 命令先于模型配置检查；命令和 Agent 启动都返回独立的完成结果。 */
export async function runChannelTurn(
  connection: ChannelConnection,
  message: ChannelInbound,
  signal: AbortSignal,
  ready: (steer: (message: ChannelInbound) => SteeringReceipt | null) => void,
): Promise<string | null> {
  const command = parseCommand(message.text);
  if (!command)
    return (await startChannelAgentTurn(connection, message, signal, ready))
      .completed;
  await ensureChannelSession(connection);
  let task: Promise<string | null> | undefined;
  try {
    const { completed } = await submitSessionCommand({
      sessionId: connection.sessionId,
      command,
      source: { kind: "channel", platform: connection.kind },
      channelId: connection.id,
      hasAttachments: message.attachments.length > 0,
      signal,
      startTask: async (input) => {
        task = (
          await startChannelAgentTurn(connection, message, signal, ready, input)
        ).completed;
        return true;
      },
    });
    const result = await completed;
    const reply = await task;
    return reply === null
      ? null
      : [result.text, reply].filter(Boolean).join("\n\n");
  } catch (error) {
    if (
      getAgentMetaForSession(useChatStore.getState(), connection.sessionId)
        .commitError
    )
      throw new ChannelError("storage");
    throw error;
  }
}

/** 执行一个外部输入，并等待既有 Bridge 完成提交与释放运行锁。 */
async function startChannelAgentTurn(
  connection: ChannelConnection,
  message: ChannelInbound,
  signal: AbortSignal,
  ready: (steer: (message: ChannelInbound) => SteeringReceipt | null) => void,
  taskMessage?: UIMessage,
): Promise<{ completed: Promise<string | null> }> {
  signal.throwIfAborted();
  const prefs = usePreferencesStore.getState();
  const config = resolveModelUsage(
    getModelUsage(prefs.modelUsages, channelModelUsageId(connection.id)),
    prefs.modelParameters,
    prefs.defaultModel,
  );
  if (
    !config ||
    !isModelRefAvailable(config.model, prefs.providerModels, prefs)
  )
    throw new ChannelError("model");
  await ensureChannelSession(connection);
  signal.throwIfAborted();
  let chat = await loadChat(connection.sessionId);
  if (
    getAgentMetaForSession(useChatStore.getState(), connection.sessionId)
      .commitError
  ) {
    // 重连只补交此前未保存的终态，绝不重新执行上一轮 Agent。
    try {
      await useChatStore
        .getState()
        .commitMessages(connection.sessionId, chat.messages);
      // 补交成功会释放后台实例，后续发送与回复必须使用重新加载的同一实例。
      chat = await loadChat(connection.sessionId);
    } catch {
      throw new ChannelError("storage");
    }
  }
  signal.throwIfAborted();
  const offset = chat.messages.length;
  const accepted = await startChatMessage(
    connection.sessionId,
    taskMessage ?? channelUserMessage(message),
    { id: connection.id, ...config },
  );
  if (!accepted) throw new ChannelError("model");
  ready((input) =>
    steerChatMessage(
      connection.sessionId,
      channelUserMessage(input),
      connection.id,
    ),
  );
  const completed = (async () => {
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
      return channelReplyText(chat.messages.slice(offset));
    } finally {
      cleanup();
    }
  })();
  // 调用方可能先保存命令回执，提前挂接拒绝处理，完成结果仍由调用方消费。
  void completed.catch(() => undefined);
  return { completed };
}
