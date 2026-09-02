/**
 * 本文件创建 AI SDK Chat 实例并衔接会话运行时。
 * 用户消息成功进入 Chat 后才提升草稿，并把 Subagent 进度转发到会话展示状态。
 */

import { HOST_PLATFORM } from "@/lib/platform";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { Chat, type UIMessage } from "@ai-sdk/react";
import {
  type ChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { modelRequiresCredential } from "../config";
import { parseSessionAgent } from "../lib/agents";
import { resolveAgentExecutionEnvironment } from "../lib/prompt";
import { resolveSessionCwd } from "../lib/sessions";
import { createSessionTransport } from "../lib/transport";
import type { ToolContext } from "../tools/tools";
import {
  chats,
  getActiveProviderKey,
  getAgentMetaForSession,
  seedMessages,
  sessionMetadata,
  touchChat,
  useChatStore,
} from "./chatStore";

function makeChat(sessionId: string): Chat<UIMessage> {
  /** 返回发送前已经冻结的会话 cwd，缺失表示运行时不变量被破坏。 */
  const getSessionCwd = () => {
    const cwd = useChatStore
      .getState()
      .sessions.find((session) => session.id === sessionId)?.cwd;
    if (!cwd) throw new Error("AI session working directory is unavailable");
    return cwd;
  };
  const toolContext: ToolContext = {
    getCwd: getSessionCwd,
    getTerminalContext: () => {
      const state = useChatStore.getState();
      return state.activeSessionId === sessionId
        ? state.live.getTerminalContext()
        : null;
    },
    isActiveTerminalPrivate: () => {
      const state = useChatStore.getState();
      return (
        state.activeSessionId === sessionId &&
        state.live.isActiveTerminalPrivate()
      );
    },
    getSessionId: () => sessionId,
    getPermissionMode: () => useChatStore.getState().permissionMode,
  };

  const transport = createSessionTransport({
    getKeys: () => useChatStore.getState().apiKeys,
    toolContext,
    getModel: () => {
      const model = useChatStore.getState().selectedModel;
      if (!model) throw new Error("No AI model is selected");
      return model;
    },
    getDefaultSubagentModel: () =>
      usePreferencesStore.getState().defaultSubagentModel,
    getMaxConcurrentSubagents: () =>
      usePreferencesStore.getState().maxConcurrentSubagents,
    getCustomInstructions: () =>
      usePreferencesStore.getState().customInstructions,
    getAgent: () => parseSessionAgent(sessionMetadata.get(sessionId)?.agent),
    getCwd: getSessionCwd,
    getEnvironment: () =>
      resolveAgentExecutionEnvironment(currentWorkspaceEnv(), HOST_PLATFORM),
    getProviderBaseURLs: () => usePreferencesStore.getState().providerBaseURLs,
    getProviderModels: () => usePreferencesStore.getState().providerModels,
    getCustomProviders: () => usePreferencesStore.getState().customProviders,
    getProviderInstanceKeys: () => useChatStore.getState().providerInstanceKeys,
    onStep: (step) => {
      useChatStore.getState().patchAgentMeta(sessionId, { step });
    },
    onCompact: (info) => {
      useChatStore.getState().patchAgentMeta(sessionId, {
        compactionNotice: { droppedCount: info.droppedCount, at: Date.now() },
      });
    },
    onFinishMeta: (info) => {
      useChatStore
        .getState()
        .patchAgentMeta(sessionId, { hitStepCap: info.hitStepCap });
    },
    onSubagentDisplay: (display) => {
      useChatStore.getState().upsertSubagentDisplay(sessionId, display);
    },
    onSystemPrompt: (systemPrompt, messages) =>
      useChatStore
        .getState()
        .persistSubmittedTurn(sessionId, messages, systemPrompt),
    onCheckpoint: (messages, event) =>
      useChatStore.getState().persistTurnCheckpoint(sessionId, messages, event),
    onUsage: (delta) => {
      const state = useChatStore.getState();
      const cur = getAgentMetaForSession(state, sessionId).tokens;
      state.patchAgentMeta(sessionId, {
        tokens: {
          inputTokens: cur.inputTokens + delta.inputTokens,
          outputTokens: cur.outputTokens + delta.outputTokens,
          cachedInputTokens: cur.cachedInputTokens + delta.cachedInputTokens,
        },
        lastInputTokens: delta.lastInputTokens,
        lastCachedTokens: delta.lastCachedTokens,
      });
    },
  }) as unknown as ChatTransport<UIMessage>;

  const initialMessages = seedMessages.get(sessionId);
  seedMessages.delete(sessionId);

  return new Chat<UIMessage>({
    id: sessionId,
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (e) => {
      useChatStore.getState().patchAgentMeta(sessionId, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    },
  });
}

export function getOrCreateChat(sessionId: string): Chat<UIMessage> {
  const existing = chats.get(sessionId);
  if (existing) {
    touchChat(sessionId, existing);
    return existing;
  }
  const c = makeChat(sessionId);
  touchChat(sessionId, c);
  return c;
}

/** 发送纯文本用户消息；消息被运行时接受后立即返回，不等待流式回复完成。 */
export async function sendMessage(text: string): Promise<boolean> {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return false;
  return startChatMessage(sessionId, {
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { createdAt: Date.now() },
  });
}

/** 发送完整用户消息；消息被运行时接受后立即返回，不等待流式回复完成。 */
export async function sendChatMessage(
  sessionId: string,
  message: Parameters<Chat<UIMessage>["sendMessage"]>[0],
): Promise<boolean> {
  return startChatMessage(sessionId, message);
}

/** 统一校验模型、Chat 状态和运行锁后启动一轮消息。 */
async function startChatMessage(
  sessionId: string,
  message: Parameters<Chat<UIMessage>["sendMessage"]>[0],
): Promise<boolean> {
  const state = useChatStore.getState();
  const cwd = resolveSessionCwd(
    sessionId,
    state.draftSessionId,
    state.sessions,
    state.live.draftCwd,
  );
  if (!cwd?.trim()) return false;
  if (!state.selectedModel) return false;
  if (
    modelRequiresCredential(state.selectedModel, {
      customProviders: usePreferencesStore.getState().customProviders,
    }) &&
    !getActiveProviderKey()
  ) {
    return false;
  }
  const chat = getOrCreateChat(sessionId);
  if (chat.status === "submitted" || chat.status === "streaming") return false;
  if (!(await state.beginSessionRun(sessionId))) return false;
  if (isUserSubmission(message)) {
    state.promoteSession(sessionId, messagesForPromotion(message), cwd);
  }
  const sending = chat.sendMessage(message);
  void sending;
  return true;
}

/** 判断待发送内容是否代表一条用户输入，兼容 AI SDK 的 text 简写形式。 */
function isUserSubmission(
  message: Parameters<Chat<UIMessage>["sendMessage"]>[0],
): boolean {
  if (!message) return false;
  if ("text" in message) return true;
  return "role" in message && message.role === "user";
}

/** 为尚未同步进 Chat 状态的用户输入构造标题所需的最小消息结构。 */
function messagesForPromotion(
  message: Parameters<Chat<UIMessage>["sendMessage"]>[0],
): UIMessage[] {
  if (!message || !("parts" in message) || !Array.isArray(message.parts)) {
    return [];
  }
  const messageWithParts = message as {
    id?: string;
    parts: UIMessage["parts"];
  };
  return [
    {
      id: messageWithParts.id ?? "pending-user-message",
      role: "user",
      parts: messageWithParts.parts,
    } as UIMessage,
  ];
}
