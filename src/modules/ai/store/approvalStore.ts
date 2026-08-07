/**
 * 本文件保存按会话隔离的 AI 工具审批请求与响应入口。
 * Toast、diff 页面和运行桥接共享同一请求，不依赖活动会话或侧栏挂载状态。
 */

import { create } from "zustand";
import type { PreparedFileMutation } from "../tools/fileMutation";

export type ApprovalRequest = {
  key: string;
  sessionId: string;
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  preview: PreparedFileMutation | null;
  previewError: string | null;
  status: "pending" | "responding";
  createdAt: number;
};

export type ApprovalResponder = (
  approvalId: string,
  approved: boolean,
) => void | PromiseLike<void>;

type ApprovalState = {
  requests: Record<string, ApprovalRequest>;
  responders: Record<string, ApprovalResponder>;
  registerResponder: (
    sessionId: string,
    responder: ApprovalResponder | null,
  ) => void;
  syncSessionRequests: (
    sessionId: string,
    requests: Omit<
      ApprovalRequest,
      "key" | "preview" | "previewError" | "status" | "createdAt"
    >[],
  ) => void;
  setPreview: (
    key: string,
    preview: PreparedFileMutation | null,
    error?: string | null,
  ) => void;
  respond: (key: string, approved: boolean) => boolean;
  clearSession: (sessionId: string) => void;
};

/** 生成跨会话唯一的审批请求键。 */
export function approvalRequestKey(
  sessionId: string,
  approvalId: string,
): string {
  return `${sessionId}:${approvalId}`;
}

export const useApprovalStore = create<ApprovalState>((set, get) => ({
  requests: {},
  responders: {},

  registerResponder: (sessionId, responder) =>
    set((state) => {
      const responders = { ...state.responders };
      if (responder) responders[sessionId] = responder;
      else delete responders[sessionId];
      return { responders };
    }),

  syncSessionRequests: (sessionId, incoming) =>
    set((state) => {
      const next = { ...state.requests };
      const incomingKeys = new Set<string>();
      for (const request of incoming) {
        const key = approvalRequestKey(sessionId, request.approvalId);
        incomingKeys.add(key);
        const existing = next[key];
        next[key] = existing ?? {
          ...request,
          key,
          preview: null,
          previewError: null,
          status: "pending",
          createdAt: Date.now(),
        };
      }
      for (const [key, request] of Object.entries(next)) {
        if (request.sessionId === sessionId && !incomingKeys.has(key)) {
          delete next[key];
        }
      }
      return { requests: next };
    }),

  setPreview: (key, preview, error = null) =>
    set((state) => {
      const request = state.requests[key];
      if (!request) return state;
      return {
        requests: {
          ...state.requests,
          [key]: { ...request, preview, previewError: error },
        },
      };
    }),

  respond: (key, approved) => {
    const state = get();
    const request = state.requests[key];
    const responder = request && state.responders[request.sessionId];
    if (request?.status !== "pending" || !responder) return false;
    set({
      requests: {
        ...state.requests,
        [key]: { ...request, status: "responding" },
      },
    });
    void responder(request.approvalId, approved);
    return true;
  },

  clearSession: (sessionId) =>
    set((state) => {
      const requests = { ...state.requests };
      const responders = { ...state.responders };
      for (const [key, request] of Object.entries(requests)) {
        if (request.sessionId === sessionId) delete requests[key];
      }
      delete responders[sessionId];
      return { requests, responders };
    }),
}));
