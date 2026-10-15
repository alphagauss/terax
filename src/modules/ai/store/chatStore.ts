/**
 * 本文件管理按会话隔离的 AI 与 Subagent 展示状态、窗口级恢复和增量持久化。
 * 首次发送冻结 cwd 与 Agent 快照，运行中 checkpoint 不释放会话运行锁。
 */

import i18n from "@/i18n";
import { readSharedStore } from "@/lib/sharedStore";
import {
  type SubagentDisplayState,
  toSubagentDisplaySnapshot,
} from "@/modules/ai/agents/subagentDisplay";
import { clearAgentTurnCoordinator } from "@/modules/ai/agents/subagentRuntime";
import {
  type CommandDisplay,
  type CommandRecord,
  projectCommands,
} from "@/modules/ai/commands/records";
import {
  clearSessionCommands,
  setSessionCommands,
  updateCommand,
} from "@/modules/ai/commands/store";
import {
  type ModelRef,
  modelRefKey,
  type ProviderId,
  providerFromBuiltinId,
  providerRequiresCredential,
} from "@/modules/ai/config";
import type {
  ExternalAgentAvailability,
  ExternalAgentId,
} from "@/modules/ai/external-agents/runtime";
import { parseExternalAgentBinding } from "@/modules/ai/external-agents/runtime";
import { snapshotAgent } from "@/modules/ai/lib/agents";
import {
  conversationEventPart,
  materializeFileEditParts,
  materializeRunFailure,
  materializeSubagentDisplayParts,
  materializeTurnMetadata,
  projectSessionMessages,
  type SessionMessage,
  type TurnEvent,
} from "@/modules/ai/lib/conversation";
import {
  peekFileEditRuntime,
  releaseFileEditRuntime,
} from "@/modules/ai/lib/fileEditRuntime";
import {
  EMPTY_PROVIDER_KEYS,
  type ProviderInstanceKeys,
  type ProviderKeys,
} from "@/modules/ai/lib/keyring";
import {
  type ModelParameterSelections,
  type ParameterAssignment,
  type ParameterSelections,
  readParameterSelections,
} from "@/modules/ai/lib/modelParameters";
import { pushRecentModel } from "@/modules/ai/lib/modelPrefs";
import { cancelAgentRun } from "@/modules/ai/lib/runLifecycle";
import {
  persistCompletedTurn,
  persistSubmittedTurn,
  persistTurnCheckpoint,
  type SessionCommitCursor,
} from "@/modules/ai/lib/sessionPersistence";
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
  resolveSessionCwd,
  type SessionData,
  type SessionFile,
  type SessionMeta,
} from "@/modules/ai/lib/sessions";
import { releaseUsage, restoreUsage } from "@/modules/ai/lib/usageRuntime";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import {
  type SessionRunOutcome,
  useSessionAttentionStore,
} from "@/modules/ai/store/sessionAttentionStore";
import {
  applyDeliveryRecord,
  projectDeliveries,
  setDeliveryHistory,
} from "@/modules/channels/history";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setDesktopModelSelection } from "@/modules/settings/store";
import {
  currentWorkspaceBootstrap,
  deleteWorkspaceValue,
  getWorkspaceValue,
  setWorkspaceValue,
} from "@/modules/workspace-process";
import type { Chat, UIMessage } from "@ai-sdk/react";
import { create } from "zustand";

export type Live = {
  openFileReference?: (path: string, line?: number) => void | Promise<void>;
  openFileEdits?: (
    input: import("@/modules/ai/lib/fileEdits").FileEditsOpenInput,
  ) => void;
  draftCwd: string | null;
  draftProjectRoot?: string | null;
  defaultDraftCwd?: string | null;
  revealWorkingDirectory: (cwd: string) => Promise<void>;
  getTerminalContext: (maxLines: number) => string | null;
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
  /** 当前活动块的纯内存计时起点，只用于恢复前台展示。 */
  activityTiming?: { key: string; startedAt: number };
  approvalsPending: number;
  error: string | null;
  /** 终态保存失败归属具体会话，后台调用方不能只等待运行锁释放。 */
  commitError?: string;
  hitStepCap: boolean;
  compacting: boolean;
};

/** 创建独立的空闲运行状态，避免不同会话共享可变嵌套对象。 */
export function createIdleAgentMeta(): AgentMeta {
  return {
    pendingSteering: 0,
    cancelled: false,
    status: "idle",
    approvalsPending: 0,
    error: null,
    hitStepCap: false,
    compacting: false,
  };
}

const IDLE_AGENT_META = createIdleAgentMeta();

type PendingSelectionInput =
  | { text: string; source: "terminal" }
  | { text: string; source: "editor"; path: string };

export type PendingSelection = PendingSelectionInput & { id: string };

export type PendingFileAttachment = {
  path: string;
};

type StoreState = {
  live: Live;
  setLive: (live: Live) => void;

  apiKeys: ProviderKeys;
  setApiKeys: (keys: ProviderKeys) => void;
  setApiKey: (provider: ProviderId, key: string | null) => void;

  providerInstanceKeys: ProviderInstanceKeys;
  setProviderInstanceKeys: (keys: ProviderInstanceKeys) => void;

  selectedModel: ModelRef | null;
  parameterSelectionsBySession: Record<string, ModelParameterSelections>;
  modelSnapshotsBySession: Record<
    string,
    { model: ModelRef; parameters: ParameterAssignment[] }
  >;
  setParameterSelections: (
    sessionId: string,
    model: ModelRef,
    selections: ParameterSelections,
  ) => Promise<void>;
  setSelectedModel: (model: ModelRef | null, recordRecent?: boolean) => void;
  externalAgentAvailability: ExternalAgentAvailability[] | null;
  setExternalAgentAvailability: (
    availability: ExternalAgentAvailability[],
  ) => void;
  draftExternalAgentId: ExternalAgentId | null;
  setDraftExternalAgent: (agentId: ExternalAgentId | null) => void;

  focusSignal: number;
  pendingPrefill: string | null;
  focusInput: (prefill?: string | null) => void;
  consumePrefill: () => string | null;

  pendingSelections: PendingSelection[];
  attachSelection: (selection: PendingSelectionInput) => void;
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
  /** 仅绑定当前草稿，项目目录变化后恢复跟随。 */
  draftCwdOverride: { sessionId: string; cwd: string } | null;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  activeSessionRevision: number;
  editingMessage: { sessionId: string; messageId: string } | null;
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
/** 发送准备跨越磁盘读取，期间不能被已经卸载的展示加载回调释放。 */
export const startingSessionIds = new Set<string>();
const acquiringSessionRuns = new Set<string>();
const sessionCommits = new Map<string, Promise<void>>();
let sessionSwitchSequence = 0;
let activeSessionPersistence = Promise.resolve();
let parameterSelectionPersistence = Promise.resolve();
let desktopSelectionPersistence = Promise.resolve();

/** 串行保存最近桌面模型及参数，确保快速操作时最后一次选择最终落盘。 */
function persistDesktopSelection(
  model: ModelRef,
  selections: ParameterSelections,
): Promise<void> {
  const write = desktopSelectionPersistence.then(() =>
    setDesktopModelSelection(model, selections),
  );
  desktopSelectionPersistence = write.catch(() => undefined);
  return write;
}

/** 最近桌面参数只作为新草稿初值，不覆盖已存在会话的独立选择。 */
function desktopDraftParameterSelections(): ModelParameterSelections {
  const { desktopModel, desktopModelParameterSelections } =
    usePreferencesStore.getState();
  return desktopModel
    ? { [modelRefKey(desktopModel)]: desktopModelParameterSelections }
    : {};
}

/** 串行保存当前窗口的活动会话选择，空值表示下次启动进入新草稿。 */
function persistActiveSession(id: string | null): Promise<void> {
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

const displayWrites = new Map<string, Promise<void>>();
const pendingDisplaySaves = new Map<
  string,
  {
    record: Extract<SessionMessage, { role: "command" | "delivery" }>;
    display?: CommandDisplay;
    release: boolean;
    saved?: boolean;
  }
>();

/** 只补交记录与释放锁，不持有或重跑命令处理函数。 */
async function flushDisplaySave(id: string, release = true): Promise<void> {
  const pending = pendingDisplaySaves.get(id);
  if (!pending) return;
  if (!pending.saved) {
    const meta = useChatStore
      .getState()
      .sessions.find((item) => item.id === id);
    if (!meta) throw new Error("Command session is unavailable");
    const committed = await commitSession({
      id,
      createdAt: meta.createdAt,
      environmentKey: meta.environmentKey,
      cwd: meta.cwd,
      metadata: sessionMetadata.get(id) ?? {},
      updatedAt: Date.now(),
      messages: [pending.record],
    });
    if (pending.display) updateCommand(id, pending.display);
    if (pending.record.role === "delivery")
      applyDeliveryRecord(id, pending.record);
    useChatStore.setState((state) => ({
      sessions: state.sessions.map((item) =>
        item.id === id ? committed : item,
      ),
    }));
    pending.saved = true;
  }
  if (pending.release && release) {
    await releaseSessionRun(id);
    useChatStore.setState((state) => {
      const runLockSessionIds = { ...state.runLockSessionIds };
      delete runLockSessionIds[id];
      return { runLockSessionIds };
    });
  }
  pendingDisplaySaves.delete(id);
}

/** 命令保留即时展示状态，持久化与人工发送共用追加入口。 */
export function appendSessionCommand(
  id: string,
  content: CommandRecord,
  display: CommandDisplay,
  channelId?: string,
): Promise<void> {
  return appendSessionDisplay(
    id,
    {
      role: "command",
      content,
      timestamp: new Date(
        content.phase === "invocation" ? display.timestamp : Date.now(),
      ).toISOString(),
    },
    channelId,
    display,
  );
}

/** 展示记录与 Agent 共用所有权；失败只补交记录，不重跑外部副作用。 */
export async function appendSessionDisplay(
  id: string,
  record: Extract<SessionMessage, { role: "command" | "delivery" }>,
  channelId?: string,
  display?: CommandDisplay,
): Promise<void> {
  while (sessionCommits.has(id)) await sessionCommits.get(id);
  const writing = (displayWrites.get(id) ?? Promise.resolve()).then(
    async () => {
      await flushDisplaySave(id);
      if (
        !sessionMetadata.has(id) &&
        useChatStore.getState().sessions.some((item) => item.id === id)
      )
        await seedSession(id);
      const state = useChatStore.getState();
      const cwd = resolveSessionCwd(
        id,
        state.draftSessionId,
        state.sessions,
        state.live.draftCwd,
        state.draftCwdOverride,
      );
      if (!cwd) throw new Error(i18n.t("ai:commands.noWorkspace"));
      const release = !state.runLockSessionIds[id];
      if (release && !(await state.beginSessionRun(id, channelId)))
        throw new Error(i18n.t("ai:commands.busy"));
      state.promoteSession(
        id,
        [
          {
            id: record.content.id,
            role: "user",
            parts: [{ type: "text", text: display?.input ?? "" }],
          },
        ],
        cwd,
      );
      pendingDisplaySaves.set(id, { record, display, release });
      await flushDisplaySave(id);
    },
  );
  displayWrites.set(id, writing);
  try {
    await writing;
    useChatStore.getState().patchAgentMeta(id, { commitError: undefined });
  } catch (error) {
    if (display) display.pending = undefined;
    useChatStore.getState().patchAgentMeta(id, { commitError: String(error) });
    throw error;
  } finally {
    if (displayWrites.get(id) === writing) displayWrites.delete(id);
  }
}

const sessionViews = new Map<string, number>();

/** 多个页面可以观察同一实例；释放展示引用不取消业务运行。 */
export function retainSessionView(id: string): () => void {
  sessionViews.set(id, (sessionViews.get(id) ?? 0) + 1);
  return () => {
    const remaining = (sessionViews.get(id) ?? 1) - 1;
    if (remaining) sessionViews.set(id, remaining);
    else sessionViews.delete(id);
    releaseUnusedChats();
  };
}

/** 保留当前视图引用和未提交的业务运行；无视图引用的已完成后台会话下次从磁盘恢复。 */
export function releaseUnusedChats() {
  const state = useChatStore.getState();
  for (const id of new Set([...chats.keys(), ...seedMessages.keys()])) {
    const chat = chats.get(id);
    if (
      (state.chatViewVisible && id === state.activeSessionId) ||
      sessionViews.has(id) ||
      state.runLockSessionIds[id] ||
      startingSessionIds.has(id) ||
      acquiringSessionRuns.has(id) ||
      sessionCommits.has(id) ||
      displayWrites.has(id) ||
      pendingDisplaySaves.has(id) ||
      chat?.status === "submitted" ||
      chat?.status === "streaming" ||
      (chat && hasPendingApproval(chat.messages))
    )
      continue;
    chats.delete(id);
    if (useChatStore.getState().editingMessage?.sessionId === id)
      useChatStore.setState({ editingMessage: null });
    clearSessionCommands(id);
    setDeliveryHistory(id);
    releaseUsage(id);
    seedMessages.delete(id);
    sessionMetadata.delete(id);
    persistedMessageCounts.delete(id);
    releaseFileEditRuntime(id);
  }
}
// Initial messages for a session, populated at hydration time and consumed
// when the matching Chat is constructed.
export const seedMessages = new Map<string, UIMessage[]>();
/** 只保留尚未落盘的压缩候选；保存重试不能再次请求摘要模型。 */
const pendingCompactionCheckpoints = new Map<
  string,
  { messages: UIMessage[]; event: Extract<TurnEvent, { event: "compaction" }> }
>();

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
export function pendingTurn(id: string) {
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

/** 冷恢复发送也能同步读取已保存的参数选择，内存中的新选择优先。 */
export function getSessionParameterSelections(
  id: string,
): ModelParameterSelections {
  const current = useChatStore.getState().parameterSelectionsBySession[id];
  if (current) return current;
  const storedSelections = getWorkspaceValue<Record<string, unknown>>(
    `ai:parameters:${id}`,
  );
  return Object.fromEntries(
    Object.entries(storedSelections ?? {}).map(([key, value]) => [
      key,
      readParameterSelections(value),
    ]),
  );
}

/** 读取磁盘记录，同时准备 UI 消息和完整会话 metadata。 */
export async function seedSession(id: string): Promise<void> {
  const before = useChatStore
    .getState()
    .sessions.find((session) => session.id === id);
  const session = await readSession(id);
  const after = useChatStore
    .getState()
    .sessions.find((session) => session.id === id);
  // 较早发起的磁盘读取不能覆盖随后已经创建的运行实例与提交游标。
  if (
    chats.has(id) ||
    (before && (!after || before.fingerprint !== after.fingerprint))
  )
    return;
  seedMessages.set(id, restoreSession(session));
}

/** 从已提交记录统一恢复消息、游标及展示缓存，避免截断后残留旧投递或统计。 */
export function restoreSession(session: SessionFile): UIMessage[] {
  const id = session.id;
  const messages = projectSessionMessages(id, session.messages);
  setSessionCommands(id, projectCommands(session.messages));
  setDeliveryHistory(id, projectDeliveries(session.messages));
  persistedMessageCounts.set(id, messages.length);
  sessionMetadata.set(id, session.metadata);
  useChatStore.setState((state) => ({
    parameterSelectionsBySession: {
      ...state.parameterSelectionsBySession,
      [id]: getSessionParameterSelections(id),
    },
  }));
  restoreUsage(id, session.messages);
  return messages;
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
  setLive: (live) =>
    set((state) => ({
      live,
      draftCwdOverride:
        state.live.draftCwd === live.draftCwd ? state.draftCwdOverride : null,
    })),

  apiKeys: { ...EMPTY_PROVIDER_KEYS },
  setApiKeys: (keys) => set({ apiKeys: keys }),
  setApiKey: (provider, key) => {
    set({ apiKeys: { ...get().apiKeys, [provider]: key } });
  },

  providerInstanceKeys: {},
  setProviderInstanceKeys: (keys) => set({ providerInstanceKeys: keys }),

  editingMessage: null,
  selectedModel: null,
  parameterSelectionsBySession: {},
  modelSnapshotsBySession: {},
  setParameterSelections: async (sessionId, model, selections) => {
    const next = {
      ...getSessionParameterSelections(sessionId),
      [modelRefKey(model)]: selections,
    };
    set((state) => ({
      parameterSelectionsBySession: {
        ...state.parameterSelectionsBySession,
        [sessionId]: next,
      },
    }));
    const write = parameterSelectionPersistence.then(() =>
      setWorkspaceValue(`ai:parameters:${sessionId}`, next),
    );
    parameterSelectionPersistence = write.catch(() => undefined);
    const state = get();
    const isActiveDesktopModel =
      state.activeSessionId === sessionId &&
      !state.sessions.find((session) => session.id === sessionId)?.channelId &&
      state.selectedModel !== null &&
      modelRefKey(state.selectedModel) === modelRefKey(model);
    await Promise.all([
      write,
      ...(isActiveDesktopModel
        ? [persistDesktopSelection(model, selections)]
        : []),
    ]);
  },
  setSelectedModel: (model, recordRecent = true) => {
    set({ selectedModel: model });
    if (model && recordRecent) {
      const sessionId = get().activeSessionId;
      const selections = sessionId
        ? (getSessionParameterSelections(sessionId)[modelRefKey(model)] ?? {})
        : {};
      void persistDesktopSelection(model, selections).catch(() => undefined);
      void pushRecentModel(model).catch(() => undefined);
    }
  },
  externalAgentAvailability: null,
  setExternalAgentAvailability: (externalAgentAvailability) =>
    set({ externalAgentAvailability }),
  draftExternalAgentId: null,
  setDraftExternalAgent: (draftExternalAgentId) => {
    if (draftExternalAgentId) useAgentsStore.getState().resetDraftAgent();
    set({ draftExternalAgentId });
  },

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
  attachSelection: (selection) => {
    const activeId = get().activeSessionId;
    if (activeId && !isSessionWritable(activeId)) return;
    const trimmed = selection.text.trim();
    if (!trimmed) return;
    const id = `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      focusSignal: s.focusSignal + 1,
      pendingSelections: [
        ...s.pendingSelections,
        { ...selection, id, text: trimmed },
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
  draftCwdOverride: null,
  sessions: [],
  activeSessionId: null,
  activeSessionRevision: 0,
  chatViewVisible: false,
  setChatViewVisible: (chatViewVisible) => set({ chatViewVisible }),
  runLockSessionIds: {},
  sessionSyncError: null,

  /** 加载会话列表；按当前窗口状态恢复有效记录，其他情况创建内存草稿。 */
  hydrateSessions: async () => {
    if (get().sessionsHydrated) return;
    try {
      const sessions = await listSessions();
      const savedActive = getWorkspaceValue<string>("ai:activeSessionId");
      const restored = savedActive
        ? (sessions.find((session) => session.id === savedActive) ?? null)
        : null;
      const draftId = restored ? null : newSessionId();
      const activeId = restored?.id ?? draftId;
      if (restored && get().chatViewVisible) await seedSession(restored.id);
      if (savedActive && !restored) await persistActiveSession(null);
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
        clearSessionCommands(session.id);
        setDeliveryHistory(session.id);
        releaseUsage(session.id);
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
      parameterSelectionsBySession: {
        ...get().parameterSelectionsBySession,
        [id]: desktopDraftParameterSelections(),
      },
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
    let committedMeta: SessionMeta;
    try {
      committedMeta = await persistTurnCheckpoint(
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
    } catch (error) {
      if (event.event === "compaction")
        pendingCompactionCheckpoints.set(id, {
          messages: completedMessages,
          event,
        });
      throw error;
    }
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
        if (channelId) {
          const { channelOwnerId } = await import(
            "@/modules/channels/identity"
          );
          const { connectionSchema } = await import("@/modules/channels/types");
          const owners = await Promise.all(
            Object.values(await readSharedStore("channels")).map(
              async (value) => {
                const connection = connectionSchema.parse(value);
                return connection.accountId ? channelOwnerId(connection) : null;
              },
            ),
          );
          if (owners.includes(channelId))
            throw new Error(i18n.t("ai:composer.channelBound"));
        }
        await clearAgentTurnCoordinator(id);
        await clearSessionProcesses(id);
        await deleteSessionFile(id);
        await parameterSelectionPersistence;
        await deleteWorkspaceValue(`ai:parameters:${id}`);
        set((state) => {
          const parameterSelectionsBySession = {
            ...state.parameterSelectionsBySession,
          };
          const modelSnapshotsBySession = { ...state.modelSnapshotsBySession };
          delete parameterSelectionsBySession[id];
          delete modelSnapshotsBySession[id];
          return { parameterSelectionsBySession, modelSnapshotsBySession };
        });
        const remaining = get().sessions.filter((session) => session.id !== id);
        await chats.get(id)?.stop();
        chats.delete(id);
        clearSessionCommands(id);
        setDeliveryHistory(id);
        releaseUsage(id);
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
      await displayWrites.get(id);
      await flushDisplaySave(id, false);
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
      if (outcome === "cancelled") pendingCompactionCheckpoints.delete(id);
      const pendingCompaction = pendingCompactionCheckpoints.get(id);
      if (pendingCompaction) {
        await get().persistTurnCheckpoint(
          id,
          pendingCompaction.messages,
          pendingCompaction.event,
        );
        const part = conversationEventPart(pendingCompaction.event);
        const offset = persistedMessageCounts.get(id) ?? 0;
        const tail = messages.slice(offset);
        if (tail[0]?.role === "assistant") {
          messages = [
            ...messages.slice(0, offset),
            { ...tail[0], parts: [...tail[0].parts, part] },
            ...tail.slice(1),
          ];
        } else {
          messages = [
            ...messages,
            { id: crypto.randomUUID(), role: "assistant", parts: [part] },
          ];
        }
        pendingCompactionCheckpoints.delete(id);
        const chat = chats.get(id);
        if (chat) chat.messages = messages;
      }
      const updatedAt = Date.now();
      const cursor = sessionCommitCursor(id);
      if (outcome === "error") {
        messages = materializeRunFailure(
          materializeTurnMetadata(messages, cursor.turnId),
          cursor.turnId,
          getAgentMetaForSession(get(), id).error,
          updatedAt,
        );
        const chat = chats.get(id);
        if (chat) chat.messages = messages;
      }
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
      if (chat)
        chat.messages = materializeTurnMetadata(
          chat.messages,
          cursor.turnId,
          outcome,
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
    state.editingMessage &&
    state.editingMessage === previous.editingMessage &&
    (state.activeSessionId !== previous.activeSessionId ||
      state.activeSessionRevision !== previous.activeSessionRevision)
  )
    useChatStore.setState({ editingMessage: null });
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
