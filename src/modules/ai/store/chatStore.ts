/**
 * 本文件管理 AI 聊天运行时、会话切换和终态发布。
 * 会话在 UI 中使用 AI SDK 消息，磁盘侧通过独立记录模型只追加新 turn。
 */

import {
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
  commitSession,
  deleteSessionFile,
  deriveTitle,
  listSessions,
  mergeSessionMetadata,
  newSessionId,
  readSession,
  releaseSessionRun,
  type SessionMeta,
} from "../lib/sessions";
import { useTodosStore } from "./todoStore";

export type Live = {
  getCwd: () => string | null;
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  injectIntoActivePty: (text: string) => boolean;
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  openWebPreview: (url: string) => boolean;
  spawnManagedAgent: (
    prompt: string,
    sessionId: string,
  ) => Promise<number | null>;
  readTerminalBuffer: (tabId: number) => string | null;
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

const ZERO_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

const IDLE_META: AgentMeta = {
  status: "idle",
  step: null,
  approvalsPending: 0,
  error: null,
  tokens: ZERO_USAGE,
  lastInputTokens: 0,
  lastCachedTokens: 0,
  hitStepCap: false,
  compactionNotice: null,
};

export type PendingSelection = {
  id: string;
  text: string;
  source: "terminal" | "editor";
};

export type PendingFileAttachment = {
  path: string;
};

export type ApprovalResponder = (approvalId: string, approved: boolean) => void;

type StoreState = {
  live: Live;
  setLive: (live: Live) => void;

  /**
   * Set by AgentRunBridge each render. Lets surfaces outside the chat hook
   * tree (e.g. the AI diff tab in the editor area) resolve a pending tool
   * approval through the active session's `addToolApprovalResponse`.
   */
  approvalResponder: ApprovalResponder | null;
  setApprovalResponder: (fn: ApprovalResponder | null) => void;
  respondToApproval: (approvalId: string, approved: boolean) => void;

  apiKeys: ProviderKeys;
  setApiKeys: (keys: ProviderKeys) => void;
  setApiKey: (provider: ProviderId, key: string | null) => void;

  customEndpointKeys: CustomEndpointKeys;
  setCustomEndpointKeys: (keys: CustomEndpointKeys) => void;

  selectedModelId: string;
  setSelectedModelId: (id: string) => void;

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

  agentMeta: AgentMeta;
  patchAgentMeta: (patch: Partial<AgentMeta>) => void;
  resetAgentMeta: () => void;

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
  ensureSessionRunLock: (id: string) => Promise<boolean>;
  newSession: () => string;
  promoteSession: (id: string, messages: UIMessage[]) => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  commitMessages: (id: string, messages: UIMessage[]) => Promise<void>;
};

const NOOP_LIVE: Live = {
  getCwd: () => null,
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  getWorkspaceRoot: () => null,
  getActiveFile: () => null,
  openWebPreview: () => false,
  spawnManagedAgent: async () => null,
  readTerminalBuffer: () => null,
};

const CHATS_LRU_CAP = 8;
export const chats = new Map<string, Chat<UIMessage>>();
const cancelledRuns = new Set<string>();

/** 更新聊天实例的 LRU 位置，并停止超出容量的非活动实例。 */
export function touchChat(id: string, c: Chat<UIMessage>) {
  if (chats.has(id)) chats.delete(id);
  chats.set(id, c);
  while (chats.size > CHATS_LRU_CAP) {
    const oldest = chats.keys().next().value;
    if (!oldest || oldest === id) break;
    if (useChatStore.getState().activeSessionId === oldest) break;
    void chats.get(oldest)?.stop();
    chats.delete(oldest);
  }
}
// Initial messages for a session, populated at hydration time and consumed
// when the matching Chat is constructed.
export const seedMessages = new Map<string, UIMessage[]>();
/** 记录磁盘已提交的 UI 消息数量，用于只转换本次新增 turn。 */
export const persistedMessageCounts = new Map<string, number>();

/** 读取磁盘记录，同时准备 UI 消息和待办事项的运行时种子。 */
async function seedSession(id: string): Promise<void> {
  const session = await readSession(id);
  const messages = projectSessionMessages(id, session.messages);
  persistedMessageCounts.set(id, messages.length);
  seedMessages.set(id, messages);
  const { seedTodos } = await import("./todoStore");
  seedTodos(id, session.todos);
}

export const useChatStore = create<StoreState>((set, get) => ({
  live: NOOP_LIVE,
  setLive: (live) => set({ live }),

  approvalResponder: null,
  setApprovalResponder: (fn) => set({ approvalResponder: fn }),
  respondToApproval: (approvalId, approved) => {
    const fn = get().approvalResponder;
    if (fn) fn(approvalId, approved);
  },

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

  focusSignal: 0,
  pendingPrefill: null,
  focusInput: (prefill = null) =>
    set((s) => ({
      focusSignal: s.focusSignal + 1,
      pendingPrefill: prefill ?? null,
    })),
  consumePrefill: () => {
    const v = get().pendingPrefill;
    if (v != null) set({ pendingPrefill: null });
    return v;
  },

  pendingSelections: [],
  attachSelection: (text, source) => {
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

  agentMeta: IDLE_META,
  patchAgentMeta: (patch) =>
    set((s) => ({ agentMeta: { ...s.agentMeta, ...patch } })),
  resetAgentMeta: () => set({ agentMeta: IDLE_META }),

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

  ensureSessionRunLock: async (id) => {
    if (get().runLockSessionIds[id]) return true;
    const acquired = await acquireSessionRun(id);
    if (acquired) {
      set({
        runLockSessionIds: { ...get().runLockSessionIds, [id]: true },
        sessionSyncError: null,
      });
      return true;
    }
    return false;
  },

  /** 切换到唯一的空白草稿，不为尚未发送的输入创建历史记录。 */
  newSession: () => {
    const activeId = get().activeSessionId;
    if (activeId && get().runLockSessionIds[activeId]) return activeId;
    const draftId = get().draftSessionId;
    if (draftId) return draftId;
    const id = newSessionId();
    set({
      draftSessionId: id,
      activeSessionId: id,
      agentMeta: IDLE_META,
    });
    return id;
  },

  /** 用户消息进入 Chat 后，将对应草稿提升为可见的历史会话。 */
  promoteSession: (id, messages) => {
    if (get().sessions.some((session) => session.id === id)) return;
    const now = Date.now();
    const meta: SessionMeta = {
      id,
      title: deriveTitle(messages),
      createdAt: now,
      updatedAt: now,
    };
    set({
      sessions: [meta, ...get().sessions],
      draftSessionId: get().draftSessionId === id ? null : get().draftSessionId,
    });
    if (get().activeSessionId === id) {
      void setWorkspaceValue("ai:activeSessionId", id);
    }
  },

  /** 切换到已持久化会话，并放弃当前未发送草稿的会话身份。 */
  switchSession: (id) => {
    if (get().activeSessionId === id) return;
    if (!get().sessions.some((s) => s.id === id)) return;
    const activeId = get().activeSessionId;
    if (activeId && get().runLockSessionIds[activeId]) return;

    // Lazily seed the chat with persisted messages the first time we open
    // this session. Subsequent switches reuse the cached Chat instance.
    const flip = () => {
      set({ activeSessionId: id, draftSessionId: null, agentMeta: IDLE_META });
      void setWorkspaceValue("ai:activeSessionId", id);
    };
    if (chats.has(id) || seedMessages.has(id)) {
      flip();
      return;
    }
    void seedSession(id)
      .catch((error) => set({ sessionSyncError: String(error) }))
      .finally(flip);
  },

  /** 删除一条历史会话，并在需要时回退到另一条历史或空白草稿。 */
  deleteSession: (id) => {
    if (Object.keys(get().runLockSessionIds).length > 0) return;
    void (async () => {
      try {
        await deleteSessionFile(id);
        await useTodosStore.getState().clearSession(id);
        const remaining = get().sessions.filter((session) => session.id !== id);
        await chats.get(id)?.stop();
        chats.delete(id);
        seedMessages.delete(id);
        persistedMessageCounts.delete(id);
        const wasActive = get().activeSessionId === id;
        const activeDraftId = get().draftSessionId;
        if (remaining.length === 0 && !wasActive && activeDraftId) {
          // 删除最后一条历史记录不能丢弃用户正在编辑的空白草稿。
          set({
            sessions: [],
            draftSessionId: activeDraftId,
            activeSessionId: activeDraftId,
          });
          return;
        }
        if (remaining.length === 0) {
          const draftId = newSessionId();
          set({
            sessions: [],
            draftSessionId: draftId,
            activeSessionId: draftId,
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
          draftSessionId:
            activeDraftId === nextActive ? activeDraftId : null,
          activeSessionId: nextActive,
        });
        if (wasActive)
          await setWorkspaceValue("ai:activeSessionId", nextActive);
      } catch (error) {
        set({ sessionSyncError: String(error) });
      }
    })();
  },

  commitMessages: async (id, messages) => {
    const sessions = get().sessions;
    const meta = sessions.find((s) => s.id === id);
    if (!meta) return;
    if (messages.length === 0 && meta.title === "New chat") {
      await releaseSessionRun(id);
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
      turnId: `turn_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      turnStatus: cancelledRuns.has(id)
        ? "cancelled"
        : get().agentMeta.status === "error"
          ? "error"
          : "completed",
    });
    await commitSession({
      id,
      title,
      createdAt: meta.createdAt,
      updatedAt,
      messages: records,
      todos: useTodosStore.getState().bySession[id] ?? [],
    });
    persistedMessageCounts.set(id, messages.length);
    cancelledRuns.delete(id);
    await releaseSessionRun(id);
    const runLockSessionIds = { ...get().runLockSessionIds };
    delete runLockSessionIds[id];
    set({
      sessions: get().sessions.map((session) =>
        session.id === id
          ? { ...session, title, updatedAt, fingerprint: "committed" }
          : session,
      ),
      runLockSessionIds,
    });
    await get().refreshSessions();
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

export function getAgentMeta(): AgentMeta {
  return useChatStore.getState().agentMeta;
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

export function stop(): void {
  const id = useChatStore.getState().activeSessionId;
  if (!id) return;
  const chat = chats.get(id);
  if (!chat) return;
  cancelledRuns.add(id);
  void chat.stop().catch(() => cancelledRuns.delete(id));
}
