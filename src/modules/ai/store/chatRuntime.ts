/**
 * 本文件创建 AI SDK Chat 实例并衔接会话运行时。
 * 用户消息成功进入 Chat 后才提升草稿，并把 Subagent 进度转发到会话展示状态。
 */

import { resolveCompactionUsage } from "@/modules/ai/lib/modelUsage";

import { isCommandActive } from "@/modules/ai/commands/store";
import { sendCompaction } from "@/modules/ai/lib/sendCompaction";
import { submitSessionCommand } from "@/modules/ai/commands/runtime";
import { parseCommand } from "@/modules/ai/commands/registry";
import i18n from "@/i18n";
import { getChannelMessageSender } from "@/modules/channels/delivery";

import {
  getAgentTurnCoordinator,
  clearAgentTurnCoordinator,
} from "@/modules/ai/agents/subagentRuntime";
import { startDesktopRunLifecycle } from "@/modules/ai/store/runLifecycle";
import type { SteeringReceipt } from "@/modules/ai/lib/turnInbox";
import { HOST_PLATFORM } from "@/lib/platform";
import {
  type ModelRef,
  isModelRefAvailable,
  modelRequiresCredential,
  providerFromBuiltinId,
} from "@/modules/ai/config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { modelRefKey } from "@/modules/ai/config";
import {
  type ParameterAssignment,
  resolveModelParameters,
} from "@/modules/ai/lib/modelParameters";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { native } from "@/modules/ai/lib/native";
import { Chat, type UIMessage } from "@ai-sdk/react";
import {
  type ChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { parseExternalAgentBinding } from "@/modules/ai/external-agents/runtime";
import { readAgentConfiguration } from "@/modules/ai/lib/agentConfiguration";
import { availableAgentTools } from "@/modules/ai/lib/agentTools";
import { parseSessionAgent } from "@/modules/ai/lib/agents";
import { resolveAgentExecutionEnvironment } from "@/modules/ai/lib/prompt";
import {
  type SessionForkTarget,
  resolveSessionCwd,
  reviseSessionHistory,
  releaseSessionRun,
} from "@/modules/ai/lib/sessions";
import { setWorkspaceValue } from "@/modules/workspace-process";
import { createSessionTransport } from "@/modules/ai/lib/transport";
import type { ToolContext } from "@/modules/ai/tools/tools";
import {
  chats,
  restoreSession,
  pendingTurns,
  stopSession,
  pendingTurn,
  getAgentMetaForSession,
  isSessionWritable,
  seedMessages,
  sessionMetadata,
  seedSession,
  releaseUnusedChats,
  startingSessionIds,
  useChatStore,
  getSessionParameterSelections,
} from "@/modules/ai/store/chatStore";

/** 发送入口冻结模型和参数，异步加载或审批续跑不再读取界面选项。 */
const runConfigurations = new WeakMap<
  Chat<UIMessage>,
  {
    model: ModelRef;
    parameters: ParameterAssignment[];
  }
>();

/** 根据会话来源解析权限，Channel 的完全访问不修改桌面全局设置。 */
function sessionPermission(sessionId: string) {
  return useChatStore.getState().sessions.find((item) => item.id === sessionId)
    ?.channelId
    ? ("full-access" as const)
    : usePreferencesStore.getState().desktopPermissionMode;
}

/** 创建会话 Chat，并保持桌面与 Channel 共用执行和持久化数据流。 */
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
    getMessageSender: () => getChannelMessageSender(sessionId),
    getCwd: getSessionCwd,
    getTerminalContext: (maxLines) => {
      const state = useChatStore.getState();
      return !state.sessions.find((item) => item.id === sessionId)?.channelId &&
        state.activeSessionId === sessionId
        ? state.live.getTerminalContext(maxLines)
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
    getPermissionMode: () => sessionPermission(sessionId),
    supportsApprovals: !sessionMetadata.get(sessionId)?.channelId,
  };

  const transport = createSessionTransport({
    getKeys: () => useChatStore.getState().apiKeys,
    toolContext,
    getModel: () => {
      const chat = chats.get(sessionId);
      const model = chat && runConfigurations.get(chat)?.model;
      if (!model) throw new Error("No AI model is selected");
      return model;
    },
    getModelParameters: (model, subagent) => {
      if (subagent) {
        const prefs = usePreferencesStore.getState();
        if (!isModelRefAvailable(model, prefs.providerModels, prefs))
          throw new Error(i18n.t("settings:models.subagent.unavailable"));
        return resolveModelParameters(
          prefs.modelParameters[modelRefKey(model)] ?? [],
          prefs.modelUsages.subagent.parameterSelections[modelRefKey(model)],
        );
      }
      const chat = chats.get(sessionId);
      return (chat && runConfigurations.get(chat)?.parameters) ?? [];
    },
    onModelSnapshot: (snapshot) => {
      useChatStore.setState((state) => ({
        modelSnapshotsBySession: {
          ...state.modelSnapshotsBySession,
          [sessionId]: snapshot,
        },
      }));
    },
    getDefaultSubagentModel: () =>
      usePreferencesStore.getState().modelUsages.subagent.model,
    getMaxConcurrentSubagents: () =>
      usePreferencesStore.getState().maxConcurrentSubagents,
    getMaxAgentSteps: () => usePreferencesStore.getState().maxAgentSteps,
    getMaxSubagentSteps: () => usePreferencesStore.getState().maxSubagentSteps,
    getCustomInstructions: () =>
      usePreferencesStore.getState().customInstructions,
    getTurnId: () => pendingTurn(sessionId).id,
    getAgent: async () => {
      const metadata = sessionMetadata.get(sessionId);
      const agent = await readAgentConfiguration(
        parseSessionAgent(metadata?.agent).id,
      );
      return {
        ...agent,
        tools: agent.tools.filter((tool) =>
          availableAgentTools(Boolean(metadata?.channelId)).includes(tool),
        ),
      };
    },
    getCwd: getSessionCwd,
    getEnvironment: async () =>
      resolveAgentExecutionEnvironment(
        currentWorkspaceEnv(),
        HOST_PLATFORM,
        await native.shellEnvironment(),
      ),
    getExternalAgent: () => {
      const state = useChatStore.getState();
      return (
        parseExternalAgentBinding(sessionMetadata.get(sessionId)) ??
        (state.draftSessionId === sessionId && state.draftExternalAgentId
          ? { agentId: state.draftExternalAgentId, sessionId: null }
          : null)
      );
    },
    getPermissionMode: () => sessionPermission(sessionId),
    getProviderBaseURLs: () => usePreferencesStore.getState().providerBaseURLs,
    getProviderModels: () => usePreferencesStore.getState().providerModels,
    getCustomProviders: () => usePreferencesStore.getState().customProviders,
    getProviderInstanceKeys: () => useChatStore.getState().providerInstanceKeys,
    getCompactionConfiguration: (parentModel, parentParameters) => {
      const prefs = usePreferencesStore.getState();
      const { model, parameters } = resolveCompactionUsage(
        prefs.modelUsages.compaction,
        prefs.modelParameters,
        parentModel,
        parentParameters,
      );
      if (!isModelRefAvailable(model, prefs.providerModels, prefs))
        throw new Error(i18n.t("settings:models.compaction.unavailable"));
      return {
        model,
        modelParameters: parameters,
        keys: useChatStore.getState().apiKeys,
        providerBaseURLs: prefs.providerBaseURLs,
        providerModels: prefs.providerModels,
        customProviders: prefs.customProviders,
        providerInstanceKeys: useChatStore.getState().providerInstanceKeys,
      };
    },
    onCompacting: (compacting) =>
      useChatStore.getState().patchAgentMeta(sessionId, { compacting }),
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
    onExternalSession: (agentId, externalSessionId) =>
      useChatStore
        .getState()
        .persistExternalAgentSession(sessionId, agentId, externalSessionId),
  }) as unknown as ChatTransport<UIMessage>;

  const initialMessages = seedMessages.get(sessionId);
  seedMessages.delete(sessionId);

  return new Chat<UIMessage>({
    id: sessionId,
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (e) => {
      void clearAgentTurnCoordinator(sessionId);
      useChatStore.getState().patchAgentMeta(sessionId, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        activityTiming: undefined,
      });
    },
  });
}

const loadingChats = new Map<string, Promise<Chat<UIMessage>>>();

/** 冷恢复前台或即将运行的会话；并发打开和发送共用一次磁盘读取。 */
export function loadChat(sessionId: string): Promise<Chat<UIMessage>> {
  const existing = chats.get(sessionId);
  if (existing) return Promise.resolve(existing);
  const pending = loadingChats.get(sessionId);
  if (pending) return pending;
  const task = (async () => {
    // 冷读取期间会话可能被其他页面移除或被磁盘新版本替换。
    for (;;) {
      const before = useChatStore
        .getState()
        .sessions.find((item) => item.id === sessionId);
      if (before && !seedMessages.has(sessionId)) await seedSession(sessionId);
      const after = useChatStore
        .getState()
        .sessions.find((item) => item.id === sessionId);
      if (before && !after) throw new Error("Session is no longer available");
      if (before?.fingerprint !== after?.fingerprint) continue;
      const chat = chats.get(sessionId) ?? makeChat(sessionId);
      chats.set(sessionId, chat);
      return chat;
    }
  })();
  loadingChats.set(sessionId, task);
  void task.finally(() => loadingChats.delete(sessionId)).catch(() => {});
  return task;
}

/** 发送纯文本用户消息；消息被运行时接受后立即返回，不等待流式回复完成。 */
export async function sendMessage(text: string): Promise<boolean> {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId || !isSessionWritable(sessionId)) return false;
  return sendChatMessage(sessionId, {
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { createdAt: Date.now() },
  });
}

/** 发送完整用户消息；消息被运行时接受后立即返回，不等待流式回复完成。 */
export async function sendChatMessage(
  sessionId: string,
  message: Omit<UIMessage, "id" | "role"> & { id?: string; role: "user" },
  hasAttachments = false,
): Promise<boolean> {
  if (
    !isSessionWritable(sessionId) ||
    isCommandActive(sessionId) ||
    getAgentMetaForSession(useChatStore.getState(), sessionId).compacting ||
    useChatStore.getState().editingMessage?.sessionId === sessionId
  )
    return false;
  await loadChat(sessionId);
  const state = useChatStore.getState();
  if (
    isCommandActive(sessionId) ||
    getAgentMetaForSession(state, sessionId).compacting
  )
    return false;
  const external =
    parseExternalAgentBinding(sessionMetadata.get(sessionId)) ||
    (state.draftSessionId === sessionId && state.draftExternalAgentId);
  const command =
    !external &&
    parseCommand(
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    );
  if (command) {
    const { completed } = await submitSessionCommand({
      sessionId,
      command,
      source: { kind: "desktop" },
      hasAttachments:
        hasAttachments || message.parts.some((part) => part.type === "file"),
      startTask: (task, signal) =>
        startChatMessage(sessionId, task, undefined, false, undefined, signal),
      startCompaction: (signal) =>
        startChatCompaction(sessionId, undefined, signal),
    });
    void completed.catch((error) =>
      useChatStore.setState({ sessionSyncError: String(error) }),
    );
    return true;
  }
  const chat = chats.get(sessionId);
  if (chat && useChatStore.getState().runLockSessionIds[sessionId]) {
    const receipt = steerChatMessage(sessionId, {
      ...message,
      id: message.id ?? crypto.randomUUID(),
      role: "user",
    } as UIMessage);
    if (receipt) return true;
    if (
      parseExternalAgentBinding(sessionMetadata.get(sessionId)) ||
      getAgentMetaForSession(useChatStore.getState(), sessionId).cancelled ||
      getAgentMetaForSession(useChatStore.getState(), sessionId).commitError
    )
      return false;
    // 当前轮已经封闭接入但终态仍在落盘时，等锁释放后作为下一轮提交。
    await new Promise<void>((resolve) => {
      const unsubscribe = useChatStore.subscribe((state) => {
        if (
          !state.runLockSessionIds[sessionId] ||
          getAgentMetaForSession(state, sessionId).cancelled ||
          getAgentMetaForSession(state, sessionId).commitError
        ) {
          unsubscribe();
          resolve();
        }
      });
      if (!useChatStore.getState().runLockSessionIds[sessionId]) {
        unsubscribe();
        resolve();
      }
    });
    const current = useChatStore.getState();
    if (
      getAgentMetaForSession(current, sessionId).cancelled ||
      getAgentMetaForSession(current, sessionId).commitError
    )
      return false;
  }
  return startChatMessage(sessionId, message);
}

/** 向当前运行接入用户引导，返回回执供 Channel 归并回复和处理取消。 */
export function steerChatMessage(
  sessionId: string,
  message: UIMessage,
  channelId?: string,
): SteeringReceipt | null {
  const state = useChatStore.getState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (
    parseCommand(
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    )
  )
    return null;
  if (
    !state.runLockSessionIds[sessionId] ||
    (channelId
      ? session?.channelId !== channelId
      : !isSessionWritable(sessionId)) ||
    parseExternalAgentBinding(sessionMetadata.get(sessionId))
  )
    return null;
  if (
    isCommandActive(sessionId) ||
    getAgentMetaForSession(state, sessionId).compacting ||
    getAgentMetaForSession(state, sessionId).cancelled
  )
    return null;
  const receipt = getAgentTurnCoordinator(sessionId).inbox.steer(message);
  if (!receipt) return null;
  state.patchAgentMeta(sessionId, {
    pendingSteering:
      getAgentMetaForSession(state, sessionId).pendingSteering + 1,
  });
  void receipt.then(() => {
    const current = useChatStore.getState();
    current.patchAgentMeta(sessionId, {
      pendingSteering: Math.max(
        0,
        getAgentMetaForSession(current, sessionId).pendingSteering - 1,
      ),
    });
  });
  return receipt;
}

/** 统一校验模型、Chat 状态和运行锁后启动一轮消息。 */
export async function startChatMessage(
  sessionId: string,
  message: Parameters<Chat<UIMessage>["sendMessage"]>[0],
  channel?: { id: string; model: ModelRef; parameters: ParameterAssignment[] },
  compaction = false,
  edit?: { messageId: string; text: string; fingerprint: string },
  signal?: AbortSignal,
): Promise<boolean> {
  const commandInput =
    compaction ||
    Boolean(
      message &&
        "metadata" in message &&
        (message.metadata as { commandId?: string } | undefined)?.commandId,
    );
  const inputBlocked = () =>
    (isCommandActive(sessionId) && !commandInput) ||
    getAgentMetaForSession(useChatStore.getState(), sessionId).compacting;
  if (
    startingSessionIds.has(sessionId) ||
    inputBlocked() ||
    (!edit && useChatStore.getState().editingMessage?.sessionId === sessionId)
  )
    return false;
  startingSessionIds.add(sessionId);
  const submissionState = useChatStore.getState();
  const prefs = usePreferencesStore.getState();
  const submittedModel = channel?.model ?? submissionState.selectedModel;
  const submittedConfig = submittedModel
    ? structuredClone({
        model: submittedModel,
        parameters: channel
          ? channel.parameters
          : resolveModelParameters(
              prefs.modelParameters[modelRefKey(submittedModel)] ?? [],
              getSessionParameterSelections(sessionId)[
                modelRefKey(submittedModel)
              ],
            ),
      })
    : null;
  try {
    const chat = await loadChat(sessionId);
    const state = useChatStore.getState();
    const cwd = resolveSessionCwd(
      sessionId,
      state.draftSessionId,
      state.sessions,
      state.live.draftCwd,
      state.draftCwdOverride,
    );
    if (!cwd?.trim()) return false;
    const externalAgent =
      parseExternalAgentBinding(sessionMetadata.get(sessionId)) ??
      (state.draftSessionId === sessionId && state.draftExternalAgentId
        ? { agentId: state.draftExternalAgentId, sessionId: null }
        : null);
    const selectedModel = submittedModel;
    if (!externalAgent && !selectedModel) return false;
    const provider =
      selectedModel && providerFromBuiltinId(selectedModel.providerId);
    const credential = provider
      ? state.apiKeys[provider]
      : selectedModel && state.providerInstanceKeys[selectedModel.providerId];
    if (
      !externalAgent &&
      selectedModel &&
      modelRequiresCredential(selectedModel, {
        customProviders: usePreferencesStore.getState().customProviders,
      }) &&
      !credential
    ) {
      return false;
    }
    if (chat.status === "submitted" || chat.status === "streaming")
      return false;
    signal?.throwIfAborted();
    if (inputBlocked()) return false;
    if (!(await state.beginSessionRun(sessionId, channel?.id))) return false;
    if (signal?.aborted) {
      pendingTurns.delete(sessionId);
      await unlockHistory(sessionId);
      signal.throwIfAborted();
    }
    if (edit) {
      try {
        const turnId = pendingTurn(sessionId).id;
        const { meta, session: saved } = await reviseSessionHistory(
          sessionId,
          edit.fingerprint,
          {
            kind: "edit",
            message_id: edit.messageId,
            text: edit.text,
            turn_id: turnId,
          },
        );
        chat.messages = restoreSession(saved);
        state.resetAgentMeta(sessionId);
        useChatStore.setState((current) => ({
          sessions: current.sessions.map((item) =>
            item.id === sessionId ? meta : item,
          ),
          editingMessage: null,
        }));
      } catch (error) {
        pendingTurns.delete(sessionId);
        await unlockHistory(sessionId);
        throw error;
      }
    }
    state.patchAgentMeta(sessionId, {
      cancelled: false,
      activityTiming: undefined,
    });
    if (submittedConfig) runConfigurations.set(chat, submittedConfig);
    if (isUserSubmission(message)) {
      state.promoteSession(sessionId, messagesForPromotion(message), cwd);
    }
    if (!externalAgent && !compaction)
      getAgentTurnCoordinator(sessionId).inbox.open();
    startDesktopRunLifecycle(sessionId, chat);
    if (message && !compaction) {
      message = {
        ...message,
        metadata: {
          ...(message.metadata as Record<string, unknown> | undefined),
          turnId: pendingTurn(sessionId).id,
        },
      };
    }
    const sending = compaction
      ? sendCompaction(chat)
      : chat.sendMessage(message);
    void sending;
    return true;
  } finally {
    startingSessionIds.delete(sessionId);
    releaseUnusedChats();
  }
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
  if (
    !message ||
    !("parts" in message) ||
    !message.parts ||
    !Array.isArray(message.parts)
  ) {
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

/** 手动压缩借用同一会话运行锁及停止按钮；命令回执等待持久化完成。 */
export async function startChatCompaction(
  sessionId: string,
  channel?: { id: string; model: ModelRef; parameters: ParameterAssignment[] },
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const chat = await loadChat(sessionId);
  signal?.throwIfAborted();
  const offset = chat.messages.length;
  if (
    !(await startChatMessage(
      sessionId,
      undefined,
      channel,
      true,
      undefined,
      signal,
    ))
  )
    throw new Error(i18n.t("ai:commands.taskRejected"));
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      void stopSession(sessionId).catch(reject);
    };
    const check = () => {
      const state = useChatStore.getState();
      const meta = getAgentMetaForSession(state, sessionId);
      if (!meta.commitError && state.runLockSessionIds[sessionId]) return;
      unsubscribe();
      signal?.removeEventListener("abort", stop);
      if (meta.commitError || meta.error || meta.cancelled || signal?.aborted)
        reject(
          new Error(
            meta.commitError ?? meta.error ?? i18n.t("ai:commands.cancelled"),
          ),
        );
      else resolve();
    };
    const unsubscribe = useChatStore.subscribe(check);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    check();
  });
  return chat.messages
    .slice(offset)
    .some((message) =>
      message.parts.some((part) => part.type === "data-compaction"),
    );
}

/** 历史操作与运行共用独占锁；不触发终态提交或重新执行旧工具。 */
async function unlockHistory(sessionId: string) {
  await releaseSessionRun(sessionId);
  useChatStore.setState((state) => {
    const locks = { ...state.runLockSessionIds };
    delete locks[sessionId];
    return { runLockSessionIds: locks };
  });
}

/** 历史操作只对已保存且没有运行或提交任务的内置桌面会话开放。 */
export function canReviseHistory(sessionId: string): boolean {
  const state = useChatStore.getState();
  return (
    Boolean(state.sessions.find((s) => s.id === sessionId)?.fingerprint) &&
    isSessionWritable(sessionId) &&
    !state.runLockSessionIds[sessionId] &&
    !isCommandActive(sessionId) &&
    !startingSessionIds.has(sessionId) &&
    !parseExternalAgentBinding(sessionMetadata.get(sessionId)) &&
    !getAgentMetaForSession(state, sessionId).commitError
  );
}

/** 原子保存修改后的最后一条用户消息，再沿用正常发送入口继续模型调用。 */
export async function editLastMessage(
  sessionId: string,
  messageId: string,
  text: string,
) {
  if (!canReviseHistory(sessionId)) return false;
  const fingerprint = useChatStore
    .getState()
    .sessions.find((s) => s.id === sessionId)?.fingerprint;
  if (!fingerprint) return false;
  return startChatMessage(sessionId, undefined, undefined, undefined, {
    messageId,
    text,
    fingerprint,
  });
}

/** 复制至选定回复或压缩检查点的原始记录；创建后不自动请求模型。 */
export async function forkSession(
  sessionId: string,
  target: SessionForkTarget,
) {
  if (!canReviseHistory(sessionId)) return;
  const state = useChatStore.getState();
  const fingerprint = state.sessions.find(
    (s) => s.id === sessionId,
  )?.fingerprint;
  if (!fingerprint) return;
  if (!(await state.beginSessionRun(sessionId))) return;
  try {
    const { meta, session } = await reviseSessionHistory(
      sessionId,
      fingerprint,
      {
        kind: "fork",
        target,
        label: i18n.t("ai:chat.forkTitle"),
      },
    );
    const selections = structuredClone(
      getSessionParameterSelections(sessionId),
    );
    await setWorkspaceValue(`ai:parameters:${meta.id}`, selections);
    useChatStore.setState((current) => ({
      sessions: [...current.sessions, meta],
      parameterSelectionsBySession: {
        ...current.parameterSelectionsBySession,
        [meta.id]: selections,
      },
    }));
    seedMessages.set(meta.id, restoreSession(session));
    state.switchSession(meta.id);
  } finally {
    await unlockHistory(sessionId);
    await useChatStore.getState().refreshSessions();
  }
}
