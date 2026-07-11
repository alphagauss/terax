import type { Chat, UIMessage } from "@ai-sdk/react";
import { create } from "zustand";
import {
  DEFAULT_MODEL_ID,
  endpointIdFromCompatModel,
  getModel,
  isCompatModelId,
  providerNeedsKey,
  type ModelId,
  type ProviderId,
} from "../config";
import { useTodosStore } from "./todoStore";
import type { AgentUsage } from "../lib/agent";
import { EMPTY_PROVIDER_KEYS, type ProviderKeys, type CustomEndpointKeys } from "../lib/keyring";
import {
  acquireSessionRun,
  deleteSessionFile,
  deriveTitle,
  listSessions,
  mergeSessionMetadata,
  newSessionId,
  publishSession,
  readSession,
  releaseSessionRun,
  type SessionMeta,
} from "../lib/sessions";
import { pushRecentModel } from "../lib/modelPrefs";
import {
  getWorkspaceValue,
  setWorkspaceValue,
} from "@/modules/workspace-process";

export type Live = {
  getCwd: () => string | null;
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  injectIntoActivePty: (text: string) => boolean;
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  openPreview: (url: string) => boolean;
  spawnManagedAgent: (
    prompt: string,
    sessionId: string,
  ) => { tabId: number; leafId: number } | null;
  readLeafBuffer: (leafId: number) => string | null;
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

export type MiniState = {
  open: boolean;
};

export type PendingSelection = {
  id: string;
  text: string;
  source: "terminal" | "editor";
};

export type ApprovalResponder = (
  approvalId: string,
  approved: boolean,
) => void;

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

  mini: MiniState;
  openMini: () => void;
  closeMini: () => void;
  toggleMini: () => void;

  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;

  focusSignal: number;
  pendingPrefill: string | null;
  focusInput: (prefill?: string | null) => void;
  consumePrefill: () => string | null;

  pendingSelections: PendingSelection[];
  attachSelection: (text: string, source: "terminal" | "editor") => void;
  consumeSelections: () => PendingSelection[];

  agentMeta: AgentMeta;
  patchAgentMeta: (patch: Partial<AgentMeta>) => void;
  resetAgentMeta: () => void;

  // Sessions
  sessionsHydrated: boolean;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  activeSessionRevision: number;
  runLockSessionIds: Record<string, true>;
  sessionSyncError: string | null;
  hydrateSessions: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  ensureSessionRunLock: (id: string) => Promise<boolean>;
  newSession: () => string;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  publishMessages: (id: string, messages: UIMessage[]) => Promise<void>;
};

const NOOP_LIVE: Live = {
  getCwd: () => null,
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  getWorkspaceRoot: () => null,
  getActiveFile: () => null,
  openPreview: () => false,
  spawnManagedAgent: () => null,
  readLeafBuffer: () => null,
};

const CHATS_LRU_CAP = 8;
export const chats = new Map<string, Chat<UIMessage>>();

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

async function seedSnapshot(id: string): Promise<void> {
  const snapshot = await readSession(id);
  seedMessages.set(id, snapshot.messages);
  const { seedTodos } = await import("./todoStore");
  seedTodos(id, snapshot.todos);
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

  mini: { open: false },
  openMini: () => set({ mini: { open: true } }),
  closeMini: () => set({ mini: { open: false } }),
  toggleMini: () => set((s) => ({ mini: { open: !s.mini.open } })),

  panelOpen: false,
  openPanel: () => {
    set({ panelOpen: true });
    void setWorkspaceValue("ai:panelOpen", true);
  },
  closePanel: () => {
    set({ panelOpen: false });
    void setWorkspaceValue("ai:panelOpen", false);
  },
  togglePanel: () =>
    set((s) => {
      const panelOpen = !s.panelOpen;
      void setWorkspaceValue("ai:panelOpen", panelOpen);
      return { panelOpen };
    }),

  focusSignal: 0,
  pendingPrefill: null,
  focusInput: (prefill = null) =>
    set((s) => ({
      panelOpen: true,
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
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingSelections: [...s.pendingSelections, { id, text: trimmed, source }],
    }));
  },
  consumeSelections: () => {
    const v = get().pendingSelections;
    if (v.length > 0) set({ pendingSelections: [] });
    return v;
  },

  agentMeta: IDLE_META,
  patchAgentMeta: (patch) =>
    set((s) => ({ agentMeta: { ...s.agentMeta, ...patch } })),
  resetAgentMeta: () => set({ agentMeta: IDLE_META }),

  sessionsHydrated: false,
  sessions: [],
  activeSessionId: null,
  activeSessionRevision: 0,
  runLockSessionIds: {},
  sessionSyncError: null,

  hydrateSessions: async () => {
    if (get().sessionsHydrated) return;
    try {
      const sessions = await listSessions();
      const savedActive = getWorkspaceValue<string>("ai:activeSessionId");
      const restored =
        sessions.find((session) => session.id === savedActive) ??
        sessions[0] ??
        null;
      const fresh: SessionMeta | null = restored
        ? null
        : {
            id: newSessionId(),
            title: "New chat",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
      const activeId = restored?.id ?? fresh?.id ?? null;
      if (restored) await seedSnapshot(restored.id);
      if (activeId) await setWorkspaceValue("ai:activeSessionId", activeId);
      set({
        sessions: fresh ? [fresh, ...sessions] : sessions,
        activeSessionId: activeId,
        panelOpen: getWorkspaceValue<boolean>("ai:panelOpen") ?? false,
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
        await useTodosStore.getState().clearSession(session.id);
      }

      const merged = mergeSessionMetadata(local, disk, runLocks);

      const activeId = get().activeSessionId;
      let activeChanged = false;
      if (activeId && !runLocks.has(activeId)) {
        const before = local.find((session) => session.id === activeId);
        const after = diskById.get(activeId);
        if (after && before?.fingerprint !== after.fingerprint) {
          await seedSnapshot(activeId);
          activeChanged = true;
        }
      }

      let next = merged;
      let nextActive = activeId;
      if (next.length === 0) {
        const id = newSessionId();
        next = [
          {
            id,
            title: "New chat",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ];
        nextActive = id;
      } else if (!activeId || !next.some((session) => session.id === activeId)) {
        nextActive = next[0].id;
      }

      if (nextActive && nextActive !== activeId) {
        const nextMeta = next.find((session) => session.id === nextActive);
        if (nextMeta?.fingerprint) await seedSnapshot(nextActive);
        await setWorkspaceValue("ai:activeSessionId", nextActive);
        activeChanged = true;
      }
      set({
        sessions: next,
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

  newSession: () => {
    const activeId = get().activeSessionId;
    if (activeId && get().runLockSessionIds[activeId]) return activeId;
    const id = newSessionId();
    const meta: SessionMeta = {
      id,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const next = [meta, ...get().sessions];
    set({ sessions: next, activeSessionId: id, agentMeta: IDLE_META });
    void setWorkspaceValue("ai:activeSessionId", id);
    return id;
  },

  switchSession: (id) => {
    if (get().activeSessionId === id) return;
    if (!get().sessions.some((s) => s.id === id)) return;
    const activeId = get().activeSessionId;
    if (activeId && get().runLockSessionIds[activeId]) return;

    // Lazily seed the chat with persisted messages the first time we open
    // this session. Subsequent switches reuse the cached Chat instance.
    const flip = () => {
      set({ activeSessionId: id, agentMeta: IDLE_META });
      void setWorkspaceValue("ai:activeSessionId", id);
    };
    if (chats.has(id) || seedMessages.has(id)) {
      flip();
      return;
    }
    void seedSnapshot(id)
      .catch((error) => set({ sessionSyncError: String(error) }))
      .finally(flip);
  },

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
        if (remaining.length === 0) {
          const fresh: SessionMeta = {
            id: newSessionId(),
            title: "New chat",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          set({ sessions: [fresh], activeSessionId: fresh.id });
          await setWorkspaceValue("ai:activeSessionId", fresh.id);
          return;
        }
        const wasActive = get().activeSessionId === id;
        const nextActive = wasActive ? remaining[0].id : get().activeSessionId;
        const nextMeta = remaining.find((session) => session.id === nextActive);
        if (
          wasActive &&
          nextMeta?.fingerprint &&
          !chats.has(nextMeta.id) &&
          !seedMessages.has(nextMeta.id)
        ) {
          try {
            await seedSnapshot(nextMeta.id);
          } catch (error) {
            set({ sessionSyncError: String(error) });
          }
        }
        set({ sessions: remaining, activeSessionId: nextActive });
        if (wasActive) await setWorkspaceValue("ai:activeSessionId", nextActive);
      } catch (error) {
        set({ sessionSyncError: String(error) });
      }
    })();
  },

  publishMessages: async (id, messages) => {
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
    await publishSession({
      schemaVersion: 1,
      id,
      title,
      createdAt: meta.createdAt,
      updatedAt,
      messages,
      todos: useTodosStore.getState().bySession[id] ?? [],
    });
    await releaseSessionRun(id);
    const runLockSessionIds = { ...get().runLockSessionIds };
    delete runLockSessionIds[id];
    set({
      sessions: get().sessions.map((session) =>
        session.id === id
          ? { ...session, title, updatedAt, fingerprint: "published" }
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
  for (const id of Object.keys(state.runLockSessionIds)) {
    const chat = chats.get(id);
    if (!chat) continue;
    if (chat.status === "submitted" || chat.status === "streaming") continue;
    if (hasPendingApproval(chat.messages)) continue;
    try {
      await useChatStore.getState().publishMessages(id, chat.messages);
    } catch (error) {
      useChatStore.setState({ sessionSyncError: String(error) });
    }
  }
}

export function getAgentMeta(): AgentMeta {
  return useChatStore.getState().agentMeta;
}

export function getActiveProviderKey(): string | null {
  const { selectedModelId, apiKeys, customEndpointKeys } = useChatStore.getState();
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
  void chats.get(id)?.stop();
}
