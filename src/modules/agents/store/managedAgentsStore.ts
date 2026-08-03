/**
 * 本文件保存由 AI 工具创建的托管 Agent 状态。
 * 每个托管 Agent 以其终端标签 ID 为唯一运行时键。
 */

import { create } from "zustand";

export const DEFAULT_MAX_ROUNDS = 3;

export type ManagedPhase = "spawning" | "working" | "reviewing" | "done";

export type ManagedAgent = {
  tabId: number;
  sessionId: string;
  task: string;
  cwd: string | null;
  rounds: number;
  maxRounds: number;
  phase: ManagedPhase;
  reviewedAtRound: number;
  pendingReview: boolean;
};

type ManagedAgentsState = {
  agents: Record<number, ManagedAgent>;
  register: (a: {
    tabId: number;
    sessionId: string;
    task: string;
    cwd: string | null;
    maxRounds?: number;
  }) => void;
  setPhase: (tabId: number, phase: ManagedPhase) => void;
  markReviewed: (tabId: number) => void;
  setPendingReview: (tabId: number, pending: boolean) => void;
  bumpRound: (tabId: number) => void;
  remove: (tabId: number) => void;
  get: (tabId: number) => ManagedAgent | undefined;
  getBySessionId: (sessionId: string) => ManagedAgent | undefined;
};

export const useManagedAgentsStore = create<ManagedAgentsState>((set, get) => ({
  agents: {},

  register: ({ tabId, sessionId, task, cwd, maxRounds }) =>
    set((s) => ({
      agents: {
        ...s.agents,
        [tabId]: {
          tabId,
          sessionId,
          task,
          cwd,
          rounds: 0,
          maxRounds: maxRounds ?? DEFAULT_MAX_ROUNDS,
          phase: "spawning",
          reviewedAtRound: -1,
          pendingReview: false,
        },
      },
    })),

  setPhase: (tabId, phase) =>
    set((s) => {
      const a = s.agents[tabId];
      if (!a || a.phase === phase) return s;
      return { agents: { ...s.agents, [tabId]: { ...a, phase } } };
    }),

  markReviewed: (tabId) =>
    set((s) => {
      const a = s.agents[tabId];
      if (!a) return s;
      return {
        agents: {
          ...s.agents,
          [tabId]: { ...a, reviewedAtRound: a.rounds, pendingReview: false },
        },
      };
    }),

  setPendingReview: (tabId, pending) =>
    set((s) => {
      const a = s.agents[tabId];
      if (!a || a.pendingReview === pending) return s;
      return {
        agents: { ...s.agents, [tabId]: { ...a, pendingReview: pending } },
      };
    }),

  bumpRound: (tabId) =>
    set((s) => {
      const a = s.agents[tabId];
      if (!a) return s;
      return {
        agents: {
          ...s.agents,
          [tabId]: { ...a, rounds: a.rounds + 1, phase: "working" },
        },
      };
    }),

  remove: (tabId) =>
    set((s) => {
      if (!s.agents[tabId]) return s;
      const next = { ...s.agents };
      delete next[tabId];
      return { agents: next };
    }),

  get: (tabId) => get().agents[tabId],

  getBySessionId: (sessionId) =>
    Object.values(get().agents).find((a) => a.sessionId === sessionId),
}));
