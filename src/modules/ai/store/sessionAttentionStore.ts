/**
 * 本文件管理 Agent 活动生命周期和 AI 会话需要用户关注的纯内存状态。
 * 状态不参与会话持久化，完成事件只供当前应用进程中的通知桥消费。
 */

import { create } from "zustand";

export type SessionAttention =
  | "background-running"
  | "completed-unread"
  | "error-unread";

export type SessionRunOutcome = "completed" | "error" | "cancelled";

export type SessionCompletion = {
  sessionId: string;
  outcome: Exclude<SessionRunOutcome, "cancelled">;
};

type SessionAttentionState = {
  /** 从 Agent 启动持续到终态保存并释放原生锁，不包含单纯的独占操作。 */
  activeRunSessionIds: Record<string, true>;
  bySession: Record<string, SessionAttention>;
  revealLatestBySession: Record<string, true>;
  pendingCompletions: SessionCompletion[];
  beginRun: (sessionId: string) => void;
  markBackgroundRunning: (sessionId: string) => void;
  markViewed: (sessionId: string) => void;
  finalizeRun: (sessionId: string, outcome: SessionRunOutcome) => void;
  requestRevealLatest: (sessionId: string) => void;
  takeRevealLatest: (sessionId: string) => boolean;
  takePendingCompletions: () => SessionCompletion[];
  clearSession: (sessionId: string) => void;
};

/**
 * 保存会话级未查看提示和一次性完成事件。
 *
 * `pendingCompletions` 通过原子取出消费，避免 React 严格模式重复触发通知。
 */
export const useSessionAttentionStore = create<SessionAttentionState>(
  (set, get) => ({
    activeRunSessionIds: {},
    bySession: {},
    revealLatestBySession: {},
    pendingCompletions: [],
    // 仅由 Agent 生命周期登记；历史修改和记录落盘的独占锁不代表运行。
    beginRun: (sessionId) =>
      set((state) => ({
        activeRunSessionIds: {
          ...state.activeRunSessionIds,
          [sessionId]: true,
        },
      })),
    markBackgroundRunning: (sessionId) =>
      set((state) => {
        if (!state.activeRunSessionIds[sessionId]) return state;
        if (state.bySession[sessionId] === "background-running") return state;
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: "background-running",
          },
        };
      }),
    markViewed: (sessionId) =>
      set((state) => {
        if (!state.bySession[sessionId]) return state;
        const bySession = { ...state.bySession };
        delete bySession[sessionId];
        return { bySession };
      }),
    finalizeRun: (sessionId, outcome) =>
      set((state) => {
        const activeRunSessionIds = { ...state.activeRunSessionIds };
        delete activeRunSessionIds[sessionId];
        const bySession = { ...state.bySession };
        if (bySession[sessionId] === "background-running") {
          if (outcome === "completed") {
            bySession[sessionId] = "completed-unread";
          } else if (outcome === "error") {
            bySession[sessionId] = "error-unread";
          } else {
            delete bySession[sessionId];
          }
        }
        if (outcome === "cancelled") return { activeRunSessionIds, bySession };
        return {
          activeRunSessionIds,
          bySession,
          pendingCompletions: [
            ...state.pendingCompletions,
            { sessionId, outcome },
          ],
        };
      }),
    requestRevealLatest: (sessionId) =>
      set((state) => ({
        revealLatestBySession: {
          ...state.revealLatestBySession,
          [sessionId]: true,
        },
      })),
    takeRevealLatest: (sessionId) => {
      const requested = get().revealLatestBySession[sessionId];
      if (!requested) return false;
      const revealLatestBySession = { ...get().revealLatestBySession };
      delete revealLatestBySession[sessionId];
      set({ revealLatestBySession });
      return true;
    },
    takePendingCompletions: () => {
      const completions = get().pendingCompletions;
      if (completions.length > 0) set({ pendingCompletions: [] });
      return completions;
    },
    clearSession: (sessionId) =>
      set((state) => {
        const activeRunSessionIds = { ...state.activeRunSessionIds };
        delete activeRunSessionIds[sessionId];
        const bySession = { ...state.bySession };
        const revealLatestBySession = { ...state.revealLatestBySession };
        delete bySession[sessionId];
        delete revealLatestBySession[sessionId];
        return {
          activeRunSessionIds,
          bySession,
          revealLatestBySession,
          pendingCompletions: state.pendingCompletions.filter(
            (completion) => completion.sessionId !== sessionId,
          ),
        };
      }),
  }),
);
