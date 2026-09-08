/**
 * 本文件管理按会话隔离的 AI 与 Subagent 展示状态、窗口级恢复和增量持久化。
 * 首次发送冻结 cwd 与 Agent 快照，运行中 checkpoint 不释放会话运行锁。
 */

import {
  peekFileEditRuntime,
  releaseFileEditRuntime,
} from "@/modules/ai/lib/fileEditRuntime";
import i18n from "@/i18n";
import { cancelAgentRun } from "@/modules/ai/lib/runLifecycle";
import {
  persistSubmittedTurn,
  persistTurnCheckpoint,
  persistCompletedTurn,
  type SessionCommitCursor,
} from "@/modules/ai/lib/sessionPersistence";
import { readSharedStore } from "@/lib/sharedStore";
import {
  type SubagentDisplayState,
  toSubagentDisplaySnapshot,
} from "@/modules/ai/agents/subagentDisplay";
import { clearAgentTurnCoordinator } from "@/modules/ai/agents/subagentRuntime";
import {
  type ModelRef,
  type ProviderId,
  providerFromBuiltinId,
  providerRequiresCredential,
} from "@/modules/ai/config";
import type {
  ExternalAgentAvailability,
  ExternalAgentId,
} from "@/modules/ai/external-agents/runtime";
import { parseExternalAgentBinding } from "@/modules/ai/external-agents/runtime";
import type { AgentUsage } from "@/modules/ai/lib/agent";
import { snapshotAgent } from "@/modules/ai/lib/agents";
import {
  materializeSubagentDisplayParts,
  materializeFileEditParts,
  projectSessionMessages,
  type TurnEvent,
} from "@/modules/ai/lib/conversation";
import {
  EMPTY_PROVIDER_KEYS,
  type ProviderInstanceKeys,
  type ProviderKeys,
} from "@/modules/ai/lib/keyring";
import { pushRecentModel } from "@/modules/ai/lib/modelPrefs";
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
  type SessionData,
  type SessionMeta,
} from "@/modules/ai/lib/sessions";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import {
  type SessionRunOutcome,
  useSessionAttentionStore,
} from "@/modules/ai/store/sessionAttentionStore";
import {
  currentWorkspaceBootstrap,
  deleteWorkspaceValue,
  getWorkspaceValue,
  setWorkspaceValue,
} from "@/modules/workspace-process";
import type { Chat, UIMessage } from "@ai-sdk/react";
import { create } from "zustand";

export type Live = {
  openFileEdits?: (
    input: import("@/modules/ai/lib/fileEdits").FileEditsOpenInput,
  ) => void;
  draftCwd: string | null;
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
  pendingSteering: number;
  cancelled: boolean;
  status: AgentRunStatus;
  step: string | null;
  approvalsPending: number;
  error: string | null;
  /** 终态保存失败归属具体会话，后台调用方不能只等待运行锁释放。 */
  commitError?: string;
  tokens: AgentUsage;
  lastInputTokens: number;
  lastCachedTokens: number;
  hitStepCap: boolean;
  compactionNotice: { droppedCount: number; at: number } | null;
};

/** 创建独立的空闲运行状态，避免不同会话共享可变嵌套对象。 */
export function createIdleAgentMeta(): AgentMeta {
  return {
    pendingSteering: 0,
    cancelled: false,
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

  providerInstanceKeys: ProviderInstanceKeys;
  setProviderInstanceKeys: (keys: ProviderInstanceKeys) => void;

  selectedModel: ModelRef | null;
  setSelectedModel: (model: ModelRef | null, recordRecent?: boolean) => void;
  externalAgentAvailability: ExternalAgentAvailability[] | null;
  setExternalAgentAvailability: (
    availability: ExternalAgentAvailability[],
  ) => void;
  draftExternalAgentId: ExternalAgentId | null;
  setDraftExternalAgent: (agentId: ExternalAgentId | null) => void;

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

  sessionAgentFilter: string | null;
  setSessionAgentFilter: (agentId: string | null) => void;

  agentMetaBySession: Record<string, AgentMeta>;
  patchAgentMeta: (sessionId: string, patch: Partial<AgentMeta>) => void;
  resetAgentMeta: (sessionId: string) => void;
  subagentDisplaysBySession: Record<
    string,
    Record<string, SubagentDisplayState>
  >;
  upsertSubagentDisplay: (
    sessionId: string,
    display: SubagentDisplayState,
  ) => void;

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
  chatViewVisible: boolean;
  setChatViewVisible: (visible: boolean) => void;
  runLockSessionIds: Record<string, true>;
  sessionSyncError: string | null;
  hydrateSessions: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  beginSessionRun: (id: string, channelId?: string) => Promise<boolean>;
  newSession: () => string;
  promoteSession: (id: string, messages: UIMessage[], cwd: string) => void;
  persistSubmittedTurn: (
    id: string,
    messages: UIMessage[],
    systemPrompt: string,
  ) => Promise<void>;
  persistTurnCheckpoint: (
    id: string,
    completedMessages: UIMessage[],
    event: TurnEvent,
  ) => Promise<void>;
  persistExternalAgentSession: (
    id: string,
    agentId: ExternalAgentId,
    externalSessionId: string,
  ) => Promise<void>;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  commitMessages: (id: string, messages: UIMessage[]) => Promise<void>;
};

const NOOP_LIVE: Live = {
  draftCwd: null,
  revealWorkingDirectory: async () => {},
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
};

export const chats = new Map<string, Chat<UIMessage>>();
const acquiringSessionRuns = new Set<string>();
const sessionCommits = new Map<string, Promise<void>>();
let sessionSwitchSequence = 0;
let activeSessionPersistence = Promise.resolve();

/** 串行保存主窗口的活动会话选择，空值表示下次启动进入新草稿。 */
function persistActiveSession(id: string | null): Promise<void> {
  if (!currentWorkspaceBootstrap().isPrimary) return Promise.resolve();
  const operation = activeSessionPersistence.then(() =>
    id === null
      ? deleteWorkspaceValue("ai:activeSessionId")
      : setWorkspaceValue("ai:activeSessionId", id),
  );
  activeSessionPersistence = operation.catch(() => undefined);
  return operation;
}

/** 读取本轮最终结果，取消优先于 AI SDK 暴露的错误状态。 */
function sessionRunOutcome(id: string): SessionRunOutcome {
  if (getAgentMetaForSession(useChatStore.getState(), id).cancelled)
    return "cancelled";
  return getAgentMetaForSession(useChatStore.getState(), id).status === "error"
    ? "error"
    : "completed";
}

/** 只保留前台展示和未提交的业务运行；已完成的后台会话下次从磁盘恢复。 */
export function releaseUnusedChats() {
  const state = useChatStore.getState();
  for (const id of new Set([...chats.keys(), ...seedMessages.keys()])) {
    const chat = chats.get(id);
    if (
      (state.chatViewVisible && id === state.activeSessionId) ||
      state.runLockSessionIds[id] ||
      acquiringSessionRuns.has(id) ||
      sessionCommits.has(id) ||
      chat?.status === "submitted" ||
      chat?.status === "streaming" ||
      (chat && hasPendingApproval(chat.messages))
    )
      continue;
    chats.delete(id);
    seedMessages.delete(id);
    sessionMetadata.delete(id);
    persistedMessageCounts.delete(id);
    releaseFileEditRuntime(id);
  }
}
// Initial messages for a session, populated at hydration time and consumed
// when the matching Chat is constructed.
export const seedMessages = new Map<string, UIMessage[]>();
/** 记录磁盘已提交的 UI 消息数量，用于只转换本次新增 turn。 */
export const persistedMessageCounts = new Map<string, number>();
/** 缓存已实际读取会话的完整 metadata，列表轮询只维护轻量摘要。 */
export const sessionMetadata = new Map<string, SessionData>();
/** 保存当前 turn 的稳定 ID 和已提交 part 位置，终态提交成功后一起释放。 */
export const pendingTurns = new Map<
  string,
  { id: string; committedParts: number }
>();

/** 同一 turn 的提交游标只在原子写入成功后推进。 */
function pendingTurn(id: string) {
  let turn = pendingTurns.get(id);
  if (!turn) {
    turn = { id: newTurnId(), committedParts: 0 };
    pendingTurns.set(id, turn);
  }
  return turn;
}

/** 将桌面缓存的提交进度交给共享持久化规则。 */
function sessionCommitCursor(id: string): SessionCommitCursor {
  const turn = pendingTurn(id);
  return {
    persistedMessages: persistedMessageCounts.get(id) ?? 0,
    committedParts: turn.committedParts,
    turnId: turn.id,
  };
}

/** 只有共享提交成功后才发布新游标，失败时保留原始重试位置。 */
function applySessionCommitCursor(id: string, cursor: SessionCommitCursor) {
  persistedMessageCounts.set(id, cursor.persistedMessages);
  pendingTurn(id).committedParts = cursor.committedParts;
}

/** 创建不暴露存储格式细节的 turn ID。 */
function newTurnId(): string {
  return `turn_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** 读取磁盘记录，同时准备 UI 消息和完整会话 metadata。 */
export async function seedSession(id: string): Promise<void> {
  const session = await readSession(id);
  // 较早发起的磁盘读取不能覆盖随后已经创建的运行实例与提交游标。
  if (chats.has(id)) return;
  const messages = projectSessionMessages(id, session.messages);
  persistedMessageCounts.set(id, messages.length);
  seedMessages.set(id, messages);
  sessionMetadata.set(id, session.metadata);
}

/** 判断持久化会话是否属于当前 Workspace 进程。 */
export function isSessionWritable(id: string): boolean {
  const session = useChatStore
    .getState()
    .sessions.find((item) => item.id === id);
  return (
    !session ||
    (!session.channelId &&
      session.environmentKey === currentWorkspaceBootstrap().environmentKey)
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

  providerInstanceKeys: {},
  setProviderInstanceKeys: (keys) => set({ providerInstanceKeys: keys }),

  selectedModel: null,
  setSelectedModel: (model, recordRecent = true) => {
    set({ selectedModel: model });
    if (model && recordRecent) void pushRecentModel(model);
  },
  externalAgentAvailability: null,
  setExternalAgentAvailability: (externalAgentAvailability) =>
    set({ externalAgentAvailability }),
  draftExternalAgentId: null,
  setDraftExternalAgent: (draftExternalAgentId) => {
    if (draftExternalAgentId) useAgentsStore.getState().resetDraftAgent();
    set({ draftExternalAgentId });
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

  sessionAgentFilter: null,
  setSessionAgentFilter: (sessionAgentFilter) => set({ sessionAgentFilter }),

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

  subagentDisplaysBySession: {},
  upsertSubagentDisplay: (sessionId, display) =>
    set((state) => ({
      subagentDisplaysBySession: {
        ...state.subagentDisplaysBySession,
        [sessionId]: {
          ...(state.subagentDisplaysBySession[sessionId] ?? {}),
          [display.toolCallId]: display,
        },
      },
    })),

  sessionsHydrated: false,
  draftSessionId: null,
  sessions: [],
  activeSessionId: null,
  activeSessionRevision: 0,
  chatViewVisible: false,
  setChatViewVisible: (chatViewVisible) => set({ chatViewVisible }),
  runLockSessionIds: {},
  sessionSyncError: null,

  /** 加载会话列表；主窗口只恢复有效记录，其他情况创建内存草稿。 */
  hydrateSessions: async () => {
    if (get().sessionsHydrated) return;
    try {
      const sessions = await listSessions();
      const primary = currentWorkspaceBootstrap().isPrimary;
      const savedActive = primary
        ? getWorkspaceValue<string>("ai:activeSessionId")
        : undefined;
      const restored = savedActive
        ? (sessions.find((session) => session.id === savedActive) ?? null)
        : null;
      const draftId = restored ? null : newSessionId();
      const activeId = restored?.id ?? draftId;
      if (restored && get().chatViewVisible) await seedSession(restored.id);
      if (primary && savedActive && !restored) await persistActiveSession(null);
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
      const deletedSessionIds: string[] = [];

      for (const session of local) {
        if (!session.fingerprint || runLocks.has(session.id)) continue;
        const after = diskById.get(session.id);
        if (after?.fingerprint === session.fingerprint) continue;
        if (!after) {
          await clearAgentTurnCoordinator(session.id);
          await clearSessionProcesses(session.id);
          useSessionAttentionStore.getState().clearSession(session.id);
          deletedSessionIds.push(session.id);
        }
        await chats.get(session.id)?.stop();
        chats.delete(session.id);
        seedMessages.delete(session.id);
        persistedMessageCounts.delete(session.id);
        sessionMetadata.delete(session.id);
        pendingTurns.delete(session.id);
      }

      const merged = mergeSessionMetadata(local, disk, runLocks);

      const activeId = get().activeSessionId;
      let activeChanged = false;
      if (activeId && !runLocks.has(activeId)) {
        const before = local.find((session) => session.id === activeId);
        const after = diskById.get(activeId);
        if (after && before?.fingerprint !== after.fingerprint) {
          if (get().chatViewVisible) await seedSession(activeId);
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
        if (!nextDraftId) nextDraftId = newSessionId();
        nextActive = nextDraftId;
      }

      if (nextActive && nextActive !== activeId) {
        const nextMeta = next.find((session) => session.id === nextActive);
        if (nextMeta?.fingerprint && get().chatViewVisible)
          await seedSession(nextActive);
        await persistActiveSession(nextMeta ? nextActive : null);
        activeChanged = true;
      }
      set((state) => {
        const agentMetaBySession = { ...state.agentMetaBySession };
        const subagentDisplaysBySession = {
          ...state.subagentDisplaysBySession,
        };
        for (const id of deletedSessionIds) delete agentMetaBySession[id];
        for (const id of deletedSessionIds) {
          delete subagentDisplaysBySession[id];
        }
        return {
          sessions: next,
          draftSessionId: nextDraftId,
          activeSessionId: nextActive,
          activeSessionRevision: activeChanged
            ? state.activeSessionRevision + 1
            : state.activeSessionRevision,
          agentMetaBySession:
            deletedSessionIds.length > 0
              ? agentMetaBySession
              : state.agentMetaBySession,
          subagentDisplaysBySession:
            deletedSessionIds.length > 0
              ? subagentDisplaysBySession
              : state.subagentDisplaysBySession,
          sessionSyncError: null,
        };
      });
    } catch (error) {
      set({ sessionSyncError: String(error) });
    }
  },

  /** 为一次新运行取得独占权；本进程已有运行或正在取锁时同样拒绝。 */
  beginSessionRun: async (id, channelId) => {
    const session = get().sessions.find((item) => item.id === id);
    const bootstrap = currentWorkspaceBootstrap();
    if (channelId) {
      if (
        !bootstrap.isPrimary ||
        bootstrap.env.kind !== "local" ||
        session?.channelId !== channelId ||
        session.environmentKey !== bootstrap.environmentKey
      )
        return false;
    } else if (!isSessionWritable(id)) return false;
    if (get().runLockSessionIds[id] || acquiringSessionRuns.has(id)) {
      return false;
    }
    acquiringSessionRuns.add(id);
    try {
      const acquired = await acquireSessionRun(id);
      if (!acquired) return false;
      set((state) => {
        const subagentDisplaysBySession = {
          ...state.subagentDisplaysBySession,
        };
        delete subagentDisplaysBySession[id];
        return {
          runLockSessionIds: { ...state.runLockSessionIds, [id]: true },
          subagentDisplaysBySession,
          sessionSyncError: null,
        };
      });
      return true;
    } finally {
      acquiringSessionRuns.delete(id);
      releaseUnusedChats();
    }
  },

  /** 切换到唯一的空白草稿，不为尚未发送的输入创建历史记录。 */
  newSession: () => {
    sessionSwitchSequence++;
    const draftId = get().draftSessionId;
    if (draftId) {
      set({ activeSessionId: draftId });
      void persistActiveSession(null);
      return draftId;
    }
    const id = newSessionId();
    useAgentsStore.getState().resetDraftAgent();
    set({
      draftSessionId: id,
      activeSessionId: id,
    });
    void persistActiveSession(null);
    return id;
  },

  /** 用户消息进入 Chat 后，将对应草稿提升为可见的历史会话。 */
  promoteSession: (id, messages, cwd) => {
    if (get().sessions.some((session) => session.id === id)) return;
    const now = Date.now();
    const title = deriveTitle(messages);
    const agent = snapshotAgent(useAgentsStore.getState().selectedDraftAgent());
    const meta: SessionMeta = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      environmentKey: currentWorkspaceBootstrap().environmentKey,
      cwd,
      agentId: agent.id,
      agentName: agent.name,
      agentIcon: agent.icon,
    };
    const externalAgentId = get().draftExternalAgentId;
    sessionMetadata.set(id, {
      title,
      agent,
      ...(externalAgentId
        ? {
            externalAgent: {
              agentId: externalAgentId,
              sessionId: null,
            },
          }
        : {}),
    });
    useAgentsStore.getState().resetDraftAgent();
    set({
      sessions: [meta, ...get().sessions],
      draftSessionId: get().draftSessionId === id ? null : get().draftSessionId,
      draftExternalAgentId: null,
    });
    if (get().activeSessionId === id) {
      void persistActiveSession(id);
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
    const cursor = sessionCommitCursor(id);
    const updatedAt = Date.now();
    const title =
      !meta.title || meta.title === "New chat"
        ? deriveTitle(messages)
        : meta.title;
    const metadata: SessionData = {
      ...(sessionMetadata.get(id) ?? {}),
      title,
      systemPrompt,
    };
    sessionMetadata.set(id, metadata);
    const committedMeta = await persistSubmittedTurn(
      {
        id,
        createdAt: meta.createdAt,
        updatedAt,
        environmentKey: currentWorkspaceBootstrap().environmentKey,
        cwd: meta.cwd,
        metadata,
        messages: [],
      },
      cursor,
      messages,
    );
    applySessionCommitCursor(id, cursor);
    set({
      sessions: get().sessions.map((session) =>
        session.id === id ? committedMeta : session,
      ),
      sessionSyncError: null,
    });
  },

  /**
   * 在同一 turn 的下一次 provider 请求前追加完整步骤、用户引导或后台结果。
   *
   * checkpoint 不前移 UIMessage 数量游标，也不释放运行锁；转换前先
   * 由当前 turn 的流 part 游标选择增量，最终提交沿用同一游标。
   */
  persistTurnCheckpoint: async (id, completedMessages, event) => {
    const meta = get().sessions.find((session) => session.id === id);
    if (!meta) throw new Error("AI session metadata is unavailable");
    const updatedAt = Date.now();
    const cursor = sessionCommitCursor(id);
    const committedMeta = await persistTurnCheckpoint(
      {
        id,
        createdAt: meta.createdAt,
        updatedAt,
        environmentKey: currentWorkspaceBootstrap().environmentKey,
        cwd: meta.cwd,
        metadata: { ...(sessionMetadata.get(id) ?? {}), title: meta.title },
        messages: [],
      },
      cursor,
      completedMessages,
      event,
    );
    applySessionCommitCursor(id, cursor);
    set({
      sessions: get().sessions.map((session) =>
        session.id === id ? committedMeta : session,
      ),
      sessionSyncError: null,
    });
  },

  /** 在持有会话运行锁时持久化 CLI 返回的稳定外部会话 ID。 */
  persistExternalAgentSession: async (id, agentId, externalSessionId) => {
    const meta = get().sessions.find((session) => session.id === id);
    if (!meta) throw new Error("AI session metadata is unavailable");
    const current = sessionMetadata.get(id) ?? {};
    const binding = parseExternalAgentBinding(current);
    if (!binding || binding.agentId !== agentId) {
      throw new Error("External Agent binding does not match the chat session");
    }
    if (binding.sessionId === externalSessionId) return;
    if (binding.sessionId) {
      throw new Error("External Agent session id cannot change");
    }
    const updatedAt = Date.now();
    const metadata: SessionData = {
      ...current,
      externalAgent: { agentId, sessionId: externalSessionId },
    };
    const committedMeta = await commitSession({
      id,
      createdAt: meta.createdAt,
      updatedAt,
      environmentKey: currentWorkspaceBootstrap().environmentKey,
      cwd: meta.cwd,
      metadata,
      messages: [],
    });
    sessionMetadata.set(id, metadata);
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
    // 运行中的会话复用业务实例；已完成后台会话重新读取持久化记录。
    const flip = () => {
      if (requestSequence !== sessionSwitchSequence) {
        releaseUnusedChats();
        return;
      }
      set({ activeSessionId: id, draftSessionId: null });
      void persistActiveSession(id);
    };
    if (!get().chatViewVisible || chats.has(id) || seedMessages.has(id)) {
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

  /** 删除一条历史会话；活动项被删除时统一回退到空白草稿。 */
  deleteSession: (id) => {
    if (get().runLockSessionIds[id]) return;
    sessionSwitchSequence++;
    void (async () => {
      try {
        const channelId = get().sessions.find(
          (session) => session.id === id,
        )?.channelId;
        if (
          channelId &&
          (await readSharedStore("channels"))[channelId] !== undefined
        ) {
          throw new Error(i18n.t("ai:composer.channelBound"));
        }
        await clearAgentTurnCoordinator(id);
        await clearSessionProcesses(id);
        await deleteSessionFile(id);
        const remaining = get().sessions.filter((session) => session.id !== id);
        await chats.get(id)?.stop();
        chats.delete(id);
        releaseFileEditRuntime(id);
        seedMessages.delete(id);
        persistedMessageCounts.delete(id);
        sessionMetadata.delete(id);
        pendingTurns.delete(id);
        useSessionAttentionStore.getState().clearSession(id);
        const agentMetaBySession = { ...get().agentMetaBySession };
        delete agentMetaBySession[id];
        const subagentDisplaysBySession = {
          ...get().subagentDisplaysBySession,
        };
        delete subagentDisplaysBySession[id];
        const wasActive = get().activeSessionId === id;
        const activeDraftId = get().draftSessionId;
        if (remaining.length === 0 && !wasActive && activeDraftId) {
          // 删除最后一条历史记录不能丢弃用户正在编辑的空白草稿。
          set({
            sessions: [],
            draftSessionId: activeDraftId,
            activeSessionId: activeDraftId,
            agentMetaBySession,
            subagentDisplaysBySession,
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
            subagentDisplaysBySession,
          });
          if (wasActive) await persistActiveSession(null);
          return;
        }
        const draftId = wasActive
          ? (activeDraftId ?? newSessionId())
          : activeDraftId;
        const nextActive = wasActive ? draftId : get().activeSessionId;
        set({
          sessions: remaining,
          draftSessionId: draftId,
          activeSessionId: nextActive,
          agentMetaBySession,
          subagentDisplaysBySession,
        });
        if (wasActive) await persistActiveSession(null);
      } catch (error) {
        set({ sessionSyncError: String(error) });
      }
    })();
  },

  /** 原子提交终态；失败保留运行锁和正文，并向该会话的等待方公开失败。 */
  commitMessages: async (id, messages) => {
    const pending = sessionCommits.get(id);
    if (pending) return pending;
    if (get().agentMetaBySession[id]?.commitError) {
      get().patchAgentMeta(id, { commitError: undefined });
    }

    const commit = (async () => {
      const sessions = get().sessions;
      const meta = sessions.find((s) => s.id === id);
      if (!meta) return;
      const outcome = sessionRunOutcome(id);
      const liveDisplays = Object.values(
        get().subagentDisplaysBySession[id] ?? {},
      );
      if (messages.length === 0 && meta.title === "New chat") {
        await releaseSessionRun(id);
        pendingTurns.delete(id);
        useSessionAttentionStore.getState().finalizeRun(id, outcome);
        const runLockSessionIds = { ...get().runLockSessionIds };
        delete runLockSessionIds[id];
        const subagentDisplaysBySession = {
          ...get().subagentDisplaysBySession,
        };
        delete subagentDisplaysBySession[id];
        set({ runLockSessionIds, subagentDisplaysBySession });
        return;
      }
      const updatedAt = Date.now();
      const cursor = sessionCommitCursor(id);
      const title =
        !meta.title || meta.title === "New chat"
          ? deriveTitle(messages)
          : meta.title;
      const snapshots = liveDisplays.map((display) =>
        toSubagentDisplaySnapshot(
          display,
          outcome === "cancelled" ? "cancelled" : "failed",
          updatedAt,
        ),
      );
      const committedMeta = await persistCompletedTurn(
        {
          id,
          createdAt: meta.createdAt,
          updatedAt,
          environmentKey: currentWorkspaceBootstrap().environmentKey,
          cwd: meta.cwd,
          metadata: { ...(sessionMetadata.get(id) ?? {}), title },
          messages: [],
        },
        cursor,
        messages,
        outcome,
        snapshots,
      );
      applySessionCommitCursor(id, cursor);
      const chat = chats.get(id);
      if (chat && snapshots.length > 0) {
        chat.messages = materializeSubagentDisplayParts(
          chat.messages,
          snapshots,
        );
      }
      if (chat)
        chat.messages = materializeFileEditParts(
          chat.messages,
          peekFileEditRuntime(id)?.snapshot(),
          cursor.turnId,
        );
      releaseFileEditRuntime(id);
      set((state) => {
        const subagentDisplaysBySession = {
          ...state.subagentDisplaysBySession,
        };
        delete subagentDisplaysBySession[id];
        return {
          sessions: state.sessions.map((session) =>
            session.id === id ? committedMeta : session,
          ),
          subagentDisplaysBySession,
        };
      });
      await get().refreshSessions();
      await releaseSessionRun(id);
      pendingTurns.delete(id);
      useSessionAttentionStore.getState().finalizeRun(id, outcome);
      const runLockSessionIds = { ...get().runLockSessionIds };
      delete runLockSessionIds[id];
      set({ runLockSessionIds });
    })();

    sessionCommits.set(id, commit);
    try {
      await commit;
    } catch (error) {
      get().patchAgentMeta(id, { commitError: String(error) });
      throw error;
    } finally {
      if (sessionCommits.get(id) === commit) sessionCommits.delete(id);
      releaseUnusedChats();
    }
  },
}));

useChatStore.subscribe((state, previous) => {
  if (
    state.activeSessionId !== previous.activeSessionId ||
    state.activeSessionRevision !== previous.activeSessionRevision ||
    state.chatViewVisible !== previous.chatViewVisible
  )
    releaseUnusedChats();
});

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
  const { selectedModel, apiKeys, providerInstanceKeys } =
    useChatStore.getState();
  if (!selectedModel) return null;
  const provider = providerFromBuiltinId(selectedModel.providerId);
  return provider
    ? (apiKeys[provider] ?? null)
    : (providerInstanceKeys[selectedModel.providerId] ?? null);
}

export function hasKeyForModel(model: ModelRef): boolean {
  const { apiKeys } = useChatStore.getState();
  const provider = providerFromBuiltinId(model.providerId);
  if (!provider) return true;
  return providerRequiresCredential(provider) ? !!apiKeys[provider] : true;
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
  const committing = sessionCommits.get(sessionId);
  if (committing) return committing;
  useChatStore.getState().patchAgentMeta(sessionId, { cancelled: true });
  await cancelAgentRun(chat, sessionId);
}
