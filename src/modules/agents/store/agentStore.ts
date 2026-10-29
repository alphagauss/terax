/**
 * 本文件保存终端 Agent 的瞬时状态、通知和本地 Agent 状态。
 * 终端会话表以标签 ID 为键，不持久化原生 PTY 资源身份。
 */

import { create } from "zustand";
import type {
  AgentNotification,
  AgentSession,
  AgentStatus,
  LocalAgentState,
} from "../lib/types";

const MAX_NOTIFICATIONS = 50;

let notifSeq = 0;

type AgentNotificationTarget = {
  source: AgentNotification["source"];
  tabId?: number;
  sessionId?: string;
};

type AgentStoreState = {
  sessions: Record<number, AgentSession>;
  localAgent: LocalAgentState;
  notifications: AgentNotification[];
  start: (tabId: number, agent: string) => void;
  setStatus: (tabId: number, status: AgentStatus) => void;
  finish: (tabId: number) => void;
  setLocalAgent: (state: LocalAgentState) => void;
  pushNotification: (n: Omit<AgentNotification, "id" | "at" | "read">) => void;
  dismissNotification: (id: string) => void;
  dismissNotificationsForTarget: (target: AgentNotificationTarget) => void;
  markAllRead: () => void;
  clearNotifications: () => void;
};

function hasSameTarget(
  notification: AgentNotification,
  target: AgentNotificationTarget,
): boolean {
  if (notification.source !== target.source) return false;
  return target.source === "terminal"
    ? notification.tabId === target.tabId
    : notification.sessionId === target.sessionId;
}

export const useAgentStore = create<AgentStoreState>((set) => ({
  sessions: {},
  localAgent: null,
  notifications: [],

  start: (tabId, agent) =>
    set((s) => {
      const now = Date.now();
      return {
        sessions: {
          ...s.sessions,
          [tabId]: {
            tabId,
            agent,
            status: "working",
            startedAt: now,
            lastActivityAt: now,
            attentionSince: null,
          },
        },
      };
    }),

  setStatus: (tabId, status) =>
    set((s) => {
      const prev = s.sessions[tabId];
      if (!prev || prev.status === status) return s;
      const now = Date.now();
      return {
        sessions: {
          ...s.sessions,
          [tabId]: {
            ...prev,
            status,
            lastActivityAt: now,
            attentionSince: status === "waiting" ? now : null,
          },
        },
      };
    }),

  finish: (tabId) =>
    set((s) => {
      if (!s.sessions[tabId]) return s;
      const next = { ...s.sessions };
      delete next[tabId];
      return { sessions: next };
    }),

  setLocalAgent: (state) =>
    set((s) => {
      const a = s.localAgent;
      if (a === state) return s;
      if (a && state && a.status === state.status && a.agent === state.agent) {
        return s;
      }
      return { localAgent: state };
    }),

  pushNotification: (n) =>
    set((s) => ({
      notifications: [
        { ...n, id: `n${++notifSeq}`, at: Date.now(), read: false },
        ...s.notifications.filter(
          (notification) => !hasSameTarget(notification, n),
        ),
      ].slice(0, MAX_NOTIFICATIONS),
    })),

  dismissNotification: (id) =>
    set((s) => ({
      notifications: s.notifications.filter(
        (notification) => notification.id !== id,
      ),
    })),

  dismissNotificationsForTarget: (target) =>
    set((s) => ({
      notifications: s.notifications.filter(
        (notification) => !hasSameTarget(notification, target),
      ),
    })),

  markAllRead: () =>
    set((s) => {
      if (!s.notifications.some((n) => !n.read)) return s;
      return {
        notifications: s.notifications.map((n) => ({ ...n, read: true })),
      };
    }),

  clearNotifications: () => set({ notifications: [] }),
}));

/** 返回最近进入等待状态的 Agent 标签 ID，供快捷键直接跳转。 */
export function nextAttentionTabId(): number | null {
  const waiting = Object.values(useAgentStore.getState().sessions)
    .filter((s) => s.status === "waiting")
    .sort((a, b) => (b.attentionSince ?? 0) - (a.attentionSince ?? 0));
  const t = waiting[0];
  return t?.tabId ?? null;
}
