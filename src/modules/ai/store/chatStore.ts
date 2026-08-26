/**
 * 本文件管理按会话隔离的 AI 运行状态、会话切换和两阶段持久化。
 * 用户消息在模型请求前落盘，后台运行的完整 Assistant 与工具记录在终态追加。
 */

import {
  currentWorkspaceBootstrap,
  getWorkspaceValue,
  setWorkspaceValue,
} from "@/modules/workspace-process";
import type { Chat, UIMessage } from "@ai-sdk/react";
import { create } from "zustand";
import {
  DEFAULT_MODEL_ID,
  endpointIdFromCompatModel,
  getModel,
  isCompatModelId,
  type ModelId,
  type ProviderId,
  providerNeedsKey,
} from "../config";
import type { AgentUsage } from "../lib/agent";
import {
  type CustomEndpointKeys,
  EMPTY_PROVIDER_KEYS,
  type ProviderKeys,
} from "../lib/keyring";
import { pushRecentModel } from "../lib/modelPrefs";
import {
  projectSessionMessages,
  serializeSessionMessages,
} from "../lib/sessionMessages";
import {
  acquireSessionRun,
  clearSessionProcesses,
  commitSession,
  deleteSessionFile,
  deriveTitle,
  listSessions,
  mergeSessionMetadata,
  newSessionId,
  readSession,
  releaseSessionRun,
  sessionTodos,
  type SessionData,
  type SessionMeta,
} from "../lib/sessions";
import { useTodosStore } from "./todoStore";
import {
  type SessionRunOutcome,
  useSessionAttentionStore,
} from "./sessionAttentionStore";

export type Live = {
  explorerRoot: string | null;
  revealWorkingDirectory: (cwd: string) => Promise<void>;
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
};

export type AgentRunStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "awaiting-approval"
  | "error";

export type AgentMeta = {
  status: AgentRunStatus;
  step: string | null;
  approvalsPending: number;
  error: string | null;
  tokens: AgentUsage;
  lastInputTokens: number;
  lastCachedTokens: number;
  hitStepCap: boolean;
  compactionNotice: { droppedCount: number; at: number } | null;
};

/** 创建独立的空闲运行状态，避免不同会话共享可变嵌套对象。 */
export function createIdleAgentMeta(): AgentMeta {
  return {
    status: "idle",
    step: null,
    approvalsPending: 0,
    error: null,
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    },
    lastInputTokens: 0,
    lastCachedTokens: 0,
    hitStepCap: false,
    compactionNotice: null,
  };
}

const IDLE_AGENT_META = createIdleAgentMeta();

export type PendingSelection = {
  id: string;
  text: string;
  source: "terminal" | "editor";
};

export type PendingFileAttachment = {
  path: string;
};

export type AiPermissionMode = "ask" | "full-access";

type StoreState = {
  live: Live;
  setLive: (live: Live) => void;

  apiKeys: ProviderKeys;
  setApiKeys: (keys: ProviderKeys) => void;
  setApiKey: (provider: ProviderId, key: string | null) => void;

  customEndpointKeys: CustomEndpointKeys;
  setCustomEndpointKeys: (keys: CustomEndpointKeys) => void;

  selectedModelId: string;
  setSelectedModelId: (id: string) => void;

  permissionMode: AiPermissionMode;
  setPermissionMode: (mode: AiPermissionMode) => void;

  focusSignal: number;
  pendingPrefill: string | null;
  focusInput: (prefill?: string | null) => void;
  consumePrefill: () => string | null;

  pendingSelections: PendingSelection[];
  attachSelection: (text: string, source: "terminal" | "editor") => void;
  consumeSelections: () => PendingSelection[];
  pendingFileAttachments: PendingFileAttachment[];
  attachFile: (path: string) => void;
  consumeFileAttachments: () => PendingFileAttachment[];

  agentMetaBySession: Record<string, AgentMeta>;
  patchAgentMeta: (sessionId: string, patch: Partial<AgentMeta>) => void;
  resetAgentMeta: (sessionId: string) => void;

  // Sessions
  sessionsHydrated: boolean;
  /**
   * 当前尚未发送用户消息的临时会话。
   *
   * 草稿只用于承载输入和 Chat 实例，绝不能进入历史列表或写入会话文件。
   */
  draftSessionId: string | null;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  activeSessionRevision: number;
  runLockSessionIds: Record<string, true>;
  sessionSyncError: string | null;
  hydrateSessions: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  beginSessionRun: (id: string) => Promise<boolean>;
  newSession: () => string;
  promoteSession: (id: string, messages: UIMessage[], cwd: string) => void;
  persistSubmittedTurn: (
    id: string,
    messages: UIMessage[],
    systemPrompt: string,
  ) => Promise<void>;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  commitMessages: (id: string, messages: UIMessage[]) => Promise<void>;
};

const NOOP_LIVE: Live = {
  explorerRoot: null,
  revealWorkingDirectory: async () => {},
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
};

const CHATS_LRU_CAP = 8;
export const chats = new Map<string, Chat<UIMessage>>();
const cancelledRuns = new Set<string>();
const acquiringSessionRuns = new Set<string>();
const sessionCommits = new Map<string, Promise<void>>();
let sessionSwitchSequence = 0;

/** 读取本轮最终结果，取消优先于 AI SDK 暴露的错误状态。 */
function sessionRunOutcome(id: string): SessionRunOutcome {
  if (cancelledRuns.has(id)) return "cancelled";
  return getAgentMetaForSession(useChatStore.getState(), id).status === "error"
    ? "error"
    : "completed";
}

/** 更新聊天实例的 LRU 位置，并只驱逐没有运行锁的非活动实例。 */
export function touchChat(id: string, c: Chat<UIMessage>) {
  if (chats.has(id)) chats.delete(id);
  chats.set(id, c);
  while (chats.size > CHATS_LRU_CAP) {
    const state = useChatStore.getState();
    const candidate = [...chats.keys()].find(
      (sessionId) =>
        sessionId !== id &&
        sessionId !== state.activeSessionId &&
        !state.runLockSessionIds[sessionId],
    );
    if (!candidate) break;
    void chats.get(candidate)?.stop();
    chats.delete(candidate);
    sessionMetadata.delete(candidate);
  }
}
// Initial messages for a session, populated at hydration time and consumed
// when the matching Chat is constructed.
export const seedMessages = new Map<string, UIMessage[]>();
/** 记录磁盘已提交的 UI 消息数量，用于只转换本次新增 turn。 */
export const persistedMessageCounts = new Map<string, number>();
/** 缓存已实际读取会话的完整 metadata，列表轮询只维护轻量摘要。 */
export const sessionMetadata = new Map<string, SessionData>();
/** 保存当前未结束 turn 的稳定 ID，发送前的用户记录与结束后的响应共用它。 */
export const pendingTurnIds = new Map<string, string>();

/** 创建不暴露存储格式细节的 turn ID。 */
function newTurnId(): string {
  return `turn_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** 读取磁盘记录，同时准备 UI 消息和待办事项的运行时种子。 */
async function seedSession(id: string): Promise<void> {
  const session = await readSession(id);
  const messages = projectSessionMessages(id, session.messages);
  persistedMessageCounts.set(id, messages.length);
  seedMessages.set(id, messages);
  sessionMetadata.set(id, session.metadata);
  const { seedTodos } = await import("./todoStore");
  seedTodos(id, sessionTodos(session.metadata));
}

/** 判断持久化会话是否属于当前 Workspace 进程。 */
export function isSessionWritable(id: string): boolean {
  const session = useChatStore
    .getState()
    .sessions.find((item) => item.id === id);
  return (
    !session ||
    session.environmentKey === currentWorkspaceBootstrap().environmentKey
  );
}

export const useChatStore = create<StoreState>((set, get) => ({
  live: NOOP_LIVE,
  setLive: (live) => set({ live }),

  apiKeys: { ...EMPTY_PROVIDER_KEYS },
  setApiKeys: (keys) => set({ apiKeys: keys }),
  setApiKey: (provider, key) => {
    set({ apiKeys: { ...get().apiKeys, [provider]: key } });
  },

  customEndpointKeys: {},
  setCustomEndpointKeys: (keys) => set({ customEndpointKeys: keys }),

  selectedModelId: DEFAULT_MODEL_ID,
  setSelectedModelId: (id) => {
    set({ selectedModelId: id });
    void pushRecentModel(id);
  },

  permissionMode: "ask",
  setPermissionMode: (permissionMode) => set({ permissionMode }),

  focusSignal: 0,
  pendingPrefill: null,
  focusInput: (prefill = null) => {
    const activeId = get().activeSessionId;
    if (activeId && !isSessionWritable(activeId)) return;
    set((s) => ({
      focusSignal: s.focusSignal + 1,
      pendingPrefill: prefill ?? null,
    }));
  },
  consumePrefill: () => {
    const v = get().pendingPrefill;
    if (v != null) set({ pendingPrefill: null });
    return v;
  },

  pendingSelections: [],
  attachSelection: (text, source) => {
    const activeId = get().activeSessionId;
    if (activeId && !isSessionWritable(activeId)) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      focusSignal: s.focusSignal + 1,
      pendingSelections: [
        ...s.pendingSelections,
        { id, text: trimmed, source },
      ],
    }));
  },
  consumeSelections: () => {
    const v = get().pendingSelections;
    if (v.length > 0) set({ pendingSelections: [] });
    return v;
  },

  pendingFileAttachments: [],
  attachFile: (path) => {
    const activeId = get().activeSessionId;
    if (activeId && !isSessionWritable(activeId)) return;
    const trimmed = path.trim();
    if (!trimmed) return;
    set((s) => ({
      pendingFileAttachments: [...s.pendingFileAttachments, { path: trimmed }],
    }));
  },
  consumeFileAttachments: () => {
    const v = get().pendingFileAttachments;
    if (v.length > 0) set({ pendingFileAttachments: [] });
    return v;
  },

  agentMetaBySession: {},
  patchAgentMeta: (sessionId, patch) =>
    set((state) => ({
      agentMetaBySession: {
        ...state.agentMetaBySession,
        [sessionId]: {
          ...(state.agentMetaBySession[sessionId] ?? createIdleAgentMeta()),
          ...patch,
        },
      },
    })),
  resetAgentMeta: (sessionId) =>
    set((state) => ({
      agentMetaBySession: {
        ...state.agentMetaBySession,
        [sessionId]: createIdleAgentMeta(),
      },
    })),

  sessionsHydrated: false,
  draftSessionId: null,
  sessions: [],
  activeSessionId: null,
  activeSessionRevision: 0,
  runLockSessionIds: {},
  sessionSyncError: null,

  /** 加载已持久化会话；没有历史记录时只创建内存草稿。 */
  hydrateSessions: async () => {
    if (get().sessionsHydrated) return;
    try {
      const sessions = await listSessions();
      const savedActive = getWorkspaceValue<string>("ai:activeSessionId");
      const restored =
        sessions.find((session) => session.id === savedActive) ??
        sessions[0] ??
        null;
      const draftId = restored ? null : newSessionId();
      const activeId = restored?.id ?? draftId;
      if (restored) await seedSession(restored.id);
      if (restored) await setWorkspaceValue("ai:activeSessionId", restored.id);
      set({
        sessions,
        draftSessionId: draftId,
        activeSessionId: activeId,
        sessionsHydrated: true,
        sessionSyncError: null,
      });
    } catch (error) {
      set({
        sessionsHydrated: true,
        sessionSyncError: String(error),
      });
    }
  },

  /** 合并其他进程写入的会话，同时保持当前未发送草稿的焦点。 */
  refreshSessions: async () => {
    try {
      const disk = await listSessions();
      const local = get().sessions;
      const diskById = new Map(disk.map((session) => [session.id, session]));
      const runLocks = new Set(Object.keys(get().runLockSessionIds));

      for (const session of local) {
        if (!session.fingerprint || runLocks.has(session.id)) continue;
        const after = diskById.get(session.id);
        if (after?.fingerprint === session.fingerprint) continue;
        await chats.get(session.id)?.stop();
        chats.delete(session.id);
        seedMessages.delete(session.id);
        persistedMessageCounts.delete(session.id);
        sessionMetadata.delete(session.id);
        pendingTurnIds.delete(session.id);
        await useTodosStore.getState().clearSession(session.id);
      }

      const merged = mergeSessionMetadata(local, disk, runLocks);

      const activeId = get().activeSessionId;
      let activeChanged = false;
      if (activeId && !runLocks.has(activeId)) {
        const before = local.find((session) => session.id === activeId);
        const after = diskById.get(activeId);
        if (after && before?.fingerprint !== after.fingerprint) {
          await seedSession(activeId);
          activeChanged = true;
        }
      }

      const next = merged;
      let nextActive = activeId;
      let nextDraftId = get().draftSessionId;
      if (next.length === 0) {
        if (!nextDraftId) nextDraftId = newSessionId();
        nextActive = nextDraftId;
      } else if (nextDraftId && activeId === nextDraftId) {
        // 用户正在编辑未发送的草稿时，其他窗口的会话刷新不能抢走焦点。
        nextActive = nextDraftId;
      } else if (
        !activeId ||
        !next.some((session) => session.id === activeId)
      ) {
        nextActive = next[0].id;
      }

      if (nextActive && nextActive !== activeId) {
        const nextMeta = next.find((session) => session.id === nextActive);
        if (nextMeta?.fingerprint) await seedSession(nextActive);
        if (nextMeta) await setWorkspaceValue("ai:activeSessionId", nextActive);
        activeChanged = true;
      }
      set({
        sessions: next,
        draftSessionId: nextDraftId,
        activeSessionId: nextActive,
        activeSessionRevision: activeChanged
          ? get().activeSessionRevision + 1
          : get().activeSessionRevision,
        sessionSyncError: null,
      });
    } catch (error) {
      set({ sessionSyncError: String(error) });
    }
  },

  /** 为一次新运行取得独占权；本进程已有运行或正在取锁时同样拒绝。 */
  beginSessionRun: async (id) => {
    if (!isSessionWritable(id)) return false;
    if (get().runLockSessionIds[id] || acquiringSessionRuns.has(id)) {
      return false;
    }
    acquiringSessionRuns.add(id);
    try {
      const acquired = await acquireSessionRun(id);
      if (!acquired) return false;
      set({
        runLockSessionIds: { ...get().runLockSessionIds, [id]: true },
        sessionSyncError: null,
      });
      return true;
    } finally {
      acquiringSessionRuns.delete(id);
    }
  },

  /** 切换到唯一的空白草稿，不为尚未发送的输入创建历史记录。 */
  newSession: () => {
    sessionSwitchSequence++;
    const draftId = get().draftSessionId;
    if (draftId) {
      set({ activeSessionId: draftId });
      return draftId;
    }
    const id = newSessionId();
    set({
      draftSessionId: id,
      activeSessionId: id,
    });
    return id;
  },

  /** 用户消息进入 Chat 后，将对应草稿提升为可见的历史会话。 */
  promoteSession: (id, messages, cwd) => {
    if (get().sessions.some((session) => session.id === id)) return;
    const now = Date.now();
    const title = deriveTitle(messages);
    const meta: SessionMeta = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      environmentKey: currentWorkspaceBootstrap().environmentKey,
      cwd,
    };
    sessionMetadata.set(id, { title, todos: [] });
    set({
      sessions: [meta, ...get().sessions],
      draftSessionId: get().draftSessionId === id ? null : get().draftSessionId,
    });
    if (get().activeSessionId === id) {
      void setWorkspaceValue("ai:activeSessionId", id);
    }
  },

  /**
   * 在模型请求开始前持久化本轮用户消息和准确系统提示词。
   *
   * `persistedMessageCounts` 只前移连续的新用户消息。等待工具审批触发的自动续传
   * 不会重复写入用户记录，后续完整 Assistant 消息仍由终态提交统一追加。
   */
  persistSubmittedTurn: async (id, messages, systemPrompt) => {
    const meta = get().sessions.find((session) => session.id === id);
    if (!meta) throw new Error("AI session metadata is unavailable");
    const persistedCount = persistedMessageCounts.get(id) ?? 0;
    if (messages.length < persistedCount) {
      throw new Error(
        "The UI message history is shorter than the session file",
      );
    }

    const submittedUsers: UIMessage[] = [];
    for (const message of messages.slice(persistedCount)) {
      if (message.role !== "user") break;
      submittedUsers.push(message);
    }

    let turnId = pendingTurnIds.get(id);
    if (!turnId) {
      turnId = newTurnId();
      pendingTurnIds.set(id, turnId);
    }
    const updatedAt = Date.now();
    const title =
      !meta.title || meta.title === "New chat"
        ? deriveTitle(messages)
        : meta.title;
    const metadata: SessionData = {
      ...(sessionMetadata.get(id) ?? {}),
      title,
      todos: useTodosStore.getState().bySession[id] ?? [],
      systemPrompt,
    };
    sessionMetadata.set(id, metadata);
    const committedMeta = await commitSession({
      id,
      createdAt: meta.createdAt,
      updatedAt,
      environmentKey: currentWorkspaceBootstrap().environmentKey,
      cwd: meta.cwd,
      metadata,
      messages: serializeSessionMessages(submittedUsers, {
        timestamp: new Date(updatedAt).toISOString(),
        turnId,
      }),
    });
    persistedMessageCounts.set(id, persistedCount + submittedUsers.length);
    set({
      sessions: get().sessions.map((session) =>
        session.id === id ? committedMeta : session,
      ),
      sessionSyncError: null,
    });
  },

  /** 切换到已持久化会话，并放弃当前未发送草稿的会话身份。 */
  switchSession: (id) => {
    const requestSequence = ++sessionSwitchSequence;
    if (get().activeSessionId === id) return;
    if (!get().sessions.some((s) => s.id === id)) return;
    // Lazily seed the chat with persisted messages the first time we open
    // this session. Subsequent switches reuse the cached Chat instance.
    const flip = () => {
      if (requestSequence !== sessionSwitchSequence) return;
      set({ activeSessionId: id, draftSessionId: null });
      void setWorkspaceValue("ai:activeSessionId", id);
    };
    if (chats.has(id) || seedMessages.has(id)) {
      flip();
      return;
    }
    void seedSession(id)
      .then(flip)
      .catch((error) => {
        if (requestSequence === sessionSwitchSequence) {
          set({ sessionSyncError: String(error) });
        }
      });
  },

  /** 删除一条历史会话，并在需要时回退到另一条历史或空白草稿。 */
  deleteSession: (id) => {
    if (get().runLockSessionIds[id]) return;
    sessionSwitchSequence++;
    void (async () => {
      try {
        await clearSessionProcesses(id);
        await deleteSessionFile(id);
        await useTodosStore.getState().clearSession(id);
        const remaining = get().sessions.filter((session) => session.id !== id);
        await chats.get(id)?.stop();
        chats.delete(id);
        seedMessages.delete(id);
        persistedMessageCounts.delete(id);
        sessionMetadata.delete(id);
        pendingTurnIds.delete(id);
        useSessionAttentionStore.getState().clearSession(id);
        const agentMetaBySession = { ...get().agentMetaBySession };
        delete agentMetaBySession[id];
        const wasActive = get().activeSessionId === id;
        const activeDraftId = get().draftSessionId;
        if (remaining.length === 0 && !wasActive && activeDraftId) {
          // 删除最后一条历史记录不能丢弃用户正在编辑的空白草稿。
          set({
            sessions: [],
            draftSessionId: activeDraftId,
            activeSessionId: activeDraftId,
            agentMetaBySession,
          });
          return;
        }
        if (remaining.length === 0) {
          const draftId = newSessionId();
          set({
            sessions: [],
            draftSessionId: draftId,
            activeSessionId: draftId,
            agentMetaBySession,
          });
          return;
        }
        const nextActive = wasActive ? remaining[0].id : get().activeSessionId;
        const nextMeta = remaining.find((session) => session.id === nextActive);
        if (
          wasActive &&
          nextMeta?.fingerprint &&
          !chats.has(nextMeta.id) &&
          !seedMessages.has(nextMeta.id)
        ) {
          try {
            await seedSession(nextMeta.id);
          } catch (error) {
            set({ sessionSyncError: String(error) });
          }
        }
        set({
          sessions: remaining,
          draftSessionId: activeDraftId === nextActive ? activeDraftId : null,
          activeSessionId: nextActive,
          agentMetaBySession,
        });
        if (wasActive)
          await setWorkspaceValue("ai:activeSessionId", nextActive);
      } catch (error) {
        set({ sessionSyncError: String(error) });
      }
    })();
  },

  commitMessages: async (id, messages) => {
    const pending = sessionCommits.get(id);
    if (pending) return pending;

    const commit = (async () => {
      const sessions = get().sessions;
      const meta = sessions.find((s) => s.id === id);
      if (!meta) return;
      const outcome = sessionRunOutcome(id);
      if (messages.length === 0 && meta.title === "New chat") {
        await releaseSessionRun(id);
        cancelledRuns.delete(id);
        pendingTurnIds.delete(id);
        useSessionAttentionStore.getState().finalizeRun(id, outcome);
        const runLockSessionIds = { ...get().runLockSessionIds };
        delete runLockSessionIds[id];
        set({ runLockSessionIds });
        return;
      }
      const updatedAt = Date.now();
      const title =
        !meta.title || meta.title === "New chat"
          ? deriveTitle(messages)
          : meta.title;
      const persistedCount = persistedMessageCounts.get(id) ?? 0;
      if (messages.length < persistedCount) {
        throw new Error(
          "The UI message history is shorter than the session file",
        );
      }
      const records = serializeSessionMessages(messages.slice(persistedCount), {
        timestamp: new Date(updatedAt).toISOString(),
        turnId: pendingTurnIds.get(id) ?? newTurnId(),
        turnStatus: outcome,
      });
      const committedMeta = await commitSession({
        id,
        createdAt: meta.createdAt,
        updatedAt,
        environmentKey: currentWorkspaceBootstrap().environmentKey,
        cwd: meta.cwd,
        metadata: {
          ...(sessionMetadata.get(id) ?? {}),
          title,
          todos: useTodosStore.getState().bySession[id] ?? [],
        },
        messages: records,
      });
      persistedMessageCounts.set(id, messages.length);
      set({
        sessions: get().sessions.map((session) =>
          session.id === id ? committedMeta : session,
        ),
      });
      await get().refreshSessions();
      await releaseSessionRun(id);
      cancelledRuns.delete(id);
      pendingTurnIds.delete(id);
      useSessionAttentionStore.getState().finalizeRun(id, outcome);
      const runLockSessionIds = { ...get().runLockSessionIds };
      delete runLockSessionIds[id];
      set({ runLockSessionIds });
    })();

    sessionCommits.set(id, commit);
    try {
      await commit;
    } finally {
      if (sessionCommits.get(id) === commit) sessionCommits.delete(id);
    }
  },
}));

function hasPendingApproval(messages: UIMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some(
        (part) => (part as { state?: string }).state === "approval-requested",
      ),
  );
}

export async function flushCompletedSessionRuns(): Promise<void> {
  const state = useChatStore.getState();
  let firstFailure: unknown;
  for (const id of Object.keys(state.runLockSessionIds)) {
    const chat = chats.get(id);
    if (!chat) continue;
    if (chat.status === "submitted" || chat.status === "streaming") continue;
    if (hasPendingApproval(chat.messages)) continue;
    try {
      await useChatStore.getState().commitMessages(id, chat.messages);
    } catch (error) {
      useChatStore.setState({ sessionSyncError: String(error) });
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}

/** 读取指定会话的运行状态，尚未运行的会话按空闲状态处理。 */
export function getAgentMetaForSession(
  state: Pick<StoreState, "agentMetaBySession">,
  sessionId: string | null,
): AgentMeta {
  return sessionId
    ? (state.agentMetaBySession[sessionId] ?? IDLE_AGENT_META)
    : IDLE_AGENT_META;
}

/** Zustand 选择器：读取当前活动会话的运行状态。 */
export function selectActiveAgentMeta(state: StoreState): AgentMeta {
  return getAgentMetaForSession(state, state.activeSessionId);
}

export function getActiveProviderKey(): string | null {
  const { selectedModelId, apiKeys, customEndpointKeys } =
    useChatStore.getState();
  if (isCompatModelId(selectedModelId)) {
    const eid = endpointIdFromCompatModel(selectedModelId);
    return customEndpointKeys[eid] ?? null;
  }
  return apiKeys[getModel(selectedModelId as ModelId).provider] ?? null;
}

export function hasKeyForModel(modelId: string): boolean {
  const { apiKeys } = useChatStore.getState();
  if (isCompatModelId(modelId)) {
    return true;
  }
  const provider = getModel(modelId as ModelId).provider;
  return providerNeedsKey(provider) ? !!apiKeys[provider] : true;
}

export function getChat(sessionId?: string): Chat<UIMessage> | undefined {
  if (sessionId) return chats.get(sessionId);
  const id = useChatStore.getState().activeSessionId;
  return id ? chats.get(id) : undefined;
}

/** 停止指定会话并标记本轮为用户取消，后台会话不会误停当前活动会话。 */
export async function stopSession(sessionId: string): Promise<void> {
  const chat = chats.get(sessionId);
  if (!chat || !useChatStore.getState().runLockSessionIds[sessionId]) return;
  cancelledRuns.add(sessionId);
  await chat.stop();
}
