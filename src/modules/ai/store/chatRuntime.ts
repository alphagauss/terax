/**
 * 本文件创建 AI SDK Chat 实例并衔接会话运行时。
 * 用户消息成功进入 Chat 后才将内存草稿提升为历史会话，空草稿不会出现在会话列表或磁盘中。
 */

import { usePreferencesStore } from "@/modules/settings/preferences";
import { Chat, type UIMessage } from "@ai-sdk/react";
import {
  type ChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { getModel, type ModelId, providerNeedsKey } from "../config";
import { BUILTIN_AGENTS } from "../lib/agents";
import { createContextAwareTransport } from "../lib/transport";
import type { ToolContext } from "../tools/tools";
import { useAgentsStore } from "./agentsStore";
import {
  chats,
  getActiveProviderKey,
  seedMessages,
  touchChat,
  useChatStore,
} from "./chatStore";
import { usePlanStore } from "./planStore";

function makeChat(sessionId: string): Chat<UIMessage> {
  const readCache = new Map<string, { size: number; hash: number }>();
  const toolContext: ToolContext = {
    getCwd: () => useChatStore.getState().live.getCwd(),
    getWorkspaceRoot: () => useChatStore.getState().live.getWorkspaceRoot(),
    getTerminalContext: () => useChatStore.getState().live.getTerminalContext(),
    isActiveTerminalPrivate: () =>
      useChatStore.getState().live.isActiveTerminalPrivate(),
    injectIntoActivePty: (text) =>
      useChatStore.getState().live.injectIntoActivePty(text),
    openWebPreview: (url) => useChatStore.getState().live.openWebPreview(url),
    spawnAgent: (prompt) =>
      useChatStore.getState().live.spawnManagedAgent(prompt, sessionId),
    readAgentOutput: (tabId) =>
      useChatStore.getState().live.readTerminalBuffer(tabId),
    readCache,
    getSessionId: () => sessionId,
  };

  const transport = createContextAwareTransport({
    getKeys: () => useChatStore.getState().apiKeys,
    toolContext,
    getModelId: () => useChatStore.getState().selectedModelId,
    getCustomInstructions: () =>
      usePreferencesStore.getState().customInstructions,
    getAgentPersona: () => {
      const { activeId, customAgents } = useAgentsStore.getState();
      const all = [...BUILTIN_AGENTS, ...customAgents];
      const a = all.find((x) => x.id === activeId) ?? BUILTIN_AGENTS[0];
      return { name: a.name, instructions: a.instructions };
    },
    getLive: () => {
      const live = useChatStore.getState().live;
      return {
        cwd: live.getCwd(),
        terminalPrivate: live.isActiveTerminalPrivate(),
        workspaceRoot: live.getWorkspaceRoot(),
        activeFile: live.getActiveFile(),
      };
    },
    getPlanMode: () => usePlanStore.getState().active,
    getLmstudioBaseURL: () => usePreferencesStore.getState().lmstudioBaseURL,
    getLmstudioModelId: () => usePreferencesStore.getState().lmstudioModelId,
    getMlxBaseURL: () => usePreferencesStore.getState().mlxBaseURL,
    getMlxModelId: () => usePreferencesStore.getState().mlxModelId,
    getOllamaBaseURL: () => usePreferencesStore.getState().ollamaBaseURL,
    getOllamaModelId: () => usePreferencesStore.getState().ollamaModelId,
    getOpenaiCompatibleBaseURL: () =>
      usePreferencesStore.getState().openaiCompatibleBaseURL,
    getOpenaiCompatibleModelId: () =>
      usePreferencesStore.getState().openaiCompatibleModelId,
    getOpenaiCompatibleContextLimit: () =>
      usePreferencesStore.getState().openaiCompatibleContextLimit,
    getOpenrouterModelId: () =>
      usePreferencesStore.getState().openrouterModelId,
    getCustomEndpoints: () => usePreferencesStore.getState().customEndpoints,
    getCustomEndpointKeys: () => useChatStore.getState().customEndpointKeys,
    onStep: (step) => {
      useChatStore.getState().patchAgentMeta({ step });
    },
    onCompact: (info) => {
      useChatStore.getState().patchAgentMeta({
        compactionNotice: { droppedCount: info.droppedCount, at: Date.now() },
      });
    },
    onFinishMeta: (info) => {
      useChatStore.getState().patchAgentMeta({ hitStepCap: info.hitStepCap });
    },
    onUsage: (delta) => {
      const cur = useChatStore.getState().agentMeta.tokens;
      useChatStore.getState().patchAgentMeta({
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
      useChatStore.getState().patchAgentMeta({
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

/** 发送纯文本用户消息，并在消息进入运行时后提升空白草稿。 */
export async function sendMessage(text: string): Promise<boolean> {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return false;
  if (
    providerNeedsKey(getModel(state.selectedModelId as ModelId).provider) &&
    !getActiveProviderKey()
  )
    return false;
  if (!(await state.ensureSessionRunLock(sessionId))) return false;
  const c = getOrCreateChat(sessionId);
  const sending = c.sendMessage({
    text,
    metadata: { createdAt: Date.now() },
  });
  state.promoteSession(
    sessionId,
    c.messages.length > 0
      ? c.messages
      : [
          {
            id: "pending-user-message",
            role: "user",
            parts: [{ type: "text", text }],
          },
        ],
  );
  await sending;
  return true;
}

/** 发送完整用户消息，供包含附件或上下文块的输入区调用。 */
export async function sendChatMessage(
  sessionId: string,
  message: Parameters<Chat<UIMessage>["sendMessage"]>[0],
): Promise<boolean> {
  const state = useChatStore.getState();
  if (!(await state.ensureSessionRunLock(sessionId))) return false;
  const chat = getOrCreateChat(sessionId);
  const sending = chat.sendMessage(message);
  if (isUserSubmission(message)) {
    state.promoteSession(
      sessionId,
      chat.messages.length > 0 ? chat.messages : messagesForPromotion(message),
    );
  }
  await sending;
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
