/**
 * 本文件将所有运行中 AI 会话的 Chat 状态桥接到按会话隔离的全局状态。
 * 负责审批注册、文件预览准备和完整 turn 提交，不依赖当前活动会话或侧栏。
 */

import { type UIMessage, useChat } from "@ai-sdk/react";
import type { UIMessagePart } from "ai";
import { useEffect, useMemo, useRef } from "react";
import { shouldCommitSession } from "../lib/sessionLifecycle";
import { useApprovalStore } from "../store/approvalStore";
import { getOrCreateChat } from "../store/chatRuntime";
import { type AgentRunStatus, useChatStore } from "../store/chatStore";
import {
  clearPreparedFileMutation,
  isTerminalFileMutationState,
  prepareFileMutation,
} from "../tools/fileMutation";

type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

type PendingApproval = {
  sessionId: string;
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

/** 为每个持有运行锁的会话保持独立桥接器。 */
export function AgentRunBridge() {
  const sessionIds = useChatStore((state) =>
    Object.keys(state.runLockSessionIds),
  );
  return (
    <>
      {sessionIds.map((sessionId) => (
        <SessionRunBridge key={sessionId} sessionId={sessionId} />
      ))}
    </>
  );
}

function SessionRunBridge({ sessionId }: { sessionId: string }) {
  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const { status, messages, addToolApprovalResponse } = useChat<UIMessage>({
    chat,
  });
  const patch = useChatStore((state) => state.patchAgentMeta);
  const commitMessages = useChatStore((state) => state.commitMessages);
  const runLocked = useChatStore((state) =>
    Boolean(state.runLockSessionIds[sessionId]),
  );
  const approvals = useMemo(
    () => collectPendingApprovals(sessionId, messages),
    [messages, sessionId],
  );
  const approvalsPending = approvals.length;

  useEffect(() => {
    useApprovalStore
      .getState()
      .registerResponder(sessionId, (approvalId, approved) =>
        addToolApprovalResponse({ id: approvalId, approved }),
      );
    return () => {
      useApprovalStore.getState().registerResponder(sessionId, null);
    };
  }, [addToolApprovalResponse, sessionId]);

  useEffect(() => {
    useApprovalStore.getState().syncSessionRequests(sessionId, approvals);
  }, [approvals, sessionId]);

  useEffect(() => {
    const cwd = useChatStore
      .getState()
      .sessions.find((session) => session.id === sessionId)?.cwd;
    if (!cwd) return;
    let cancelled = false;
    for (const approval of approvals) {
      if (!isFileMutation(approval.toolName)) continue;
      const key = `${sessionId}:${approval.approvalId}`;
      const request = useApprovalStore.getState().requests[key];
      if (!request || request.preview || request.previewError) continue;
      void prepareFileMutation({
        sessionId,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        input: approval.input,
        cwd,
      })
        .then((preview) => {
          if (!cancelled) {
            useApprovalStore.getState().setPreview(key, preview);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            useApprovalStore.getState().setPreview(key, null, String(error));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [approvals, sessionId]);

  useEffect(() => {
    clearTerminalFileMutations(sessionId, messages);
  }, [messages, sessionId]);

  const latestMessages = useRef(messages);
  latestMessages.current = messages;
  useEffect(
    () => () => {
      clearSessionFileMutations(sessionId, latestMessages.current);
    },
    [sessionId],
  );
  const committing = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;
  const approvalsRef = useRef(approvalsPending);
  approvalsRef.current = approvalsPending;
  const runLockedRef = useRef(runLocked);
  runLockedRef.current = runLocked;

  useEffect(() => {
    if (!shouldCommitSession(status, approvalsPending, runLocked)) return;
    const timer = window.setTimeout(() => {
      if (
        !shouldCommitSession(
          statusRef.current,
          approvalsRef.current,
          runLockedRef.current,
        ) ||
        committing.current
      ) {
        return;
      }
      committing.current = true;
      void commitMessages(sessionId, latestMessages.current)
        .catch((error) => {
          useChatStore.setState({ sessionSyncError: String(error) });
        })
        .finally(() => {
          committing.current = false;
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [approvalsPending, commitMessages, runLocked, sessionId, status]);

  useEffect(
    () => () => {
      if (
        !shouldCommitSession(
          statusRef.current,
          approvalsRef.current,
          runLockedRef.current,
        ) ||
        committing.current
      ) {
        return;
      }
      committing.current = true;
      void commitMessages(sessionId, latestMessages.current).catch((error) => {
        console.error(
          "Failed to save AI session during bridge cleanup:",
          error,
        );
      });
    },
    [commitMessages, sessionId],
  );

  useEffect(() => {
    let runStatus: AgentRunStatus;
    if (approvalsPending > 0) runStatus = "awaiting-approval";
    else if (status === "submitted") runStatus = "thinking";
    else if (status === "streaming") runStatus = "streaming";
    else if (status === "error") runStatus = "error";
    else runStatus = "idle";
    patch(sessionId, {
      status: runStatus,
      approvalsPending,
      ...(runStatus === "idle" || runStatus === "error" ? { step: null } : {}),
      ...(runStatus === "idle" ? { error: null } : {}),
    });
  }, [approvalsPending, patch, sessionId, status]);

  return null;
}

function collectPendingApprovals(
  sessionId: string,
  messages: readonly UIMessage[],
): PendingApproval[] {
  const approvals: PendingApproval[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts as AnyPart[]) {
      const candidate = part as unknown as {
        type?: string;
        toolName?: string;
        toolCallId?: string;
        state?: string;
        input?: unknown;
        approval?: { id?: string };
      };
      if (candidate.state !== "approval-requested") continue;
      const approvalId = candidate.approval?.id;
      const toolCallId = candidate.toolCallId;
      if (!approvalId || !toolCallId) continue;
      const toolName =
        candidate.type === "dynamic-tool"
          ? (candidate.toolName ?? "unknown")
          : (candidate.type?.replace(/^tool-/, "") ?? "unknown");
      approvals.push({
        sessionId,
        approvalId,
        toolCallId,
        toolName,
        input: asRecord(candidate.input),
      });
    }
  }
  return approvals;
}

function clearTerminalFileMutations(
  sessionId: string,
  messages: readonly UIMessage[],
): void {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts as AnyPart[]) {
      const candidate = part as unknown as {
        type?: string;
        toolName?: string;
        toolCallId?: string;
        state?: string;
      };
      const toolName =
        candidate.type === "dynamic-tool"
          ? candidate.toolName
          : candidate.type?.replace(/^tool-/, "");
      if (
        candidate.toolCallId &&
        toolName &&
        isFileMutation(toolName) &&
        isTerminalFileMutationState(candidate.state)
      ) {
        clearPreparedFileMutation(sessionId, candidate.toolCallId);
      }
    }
  }
}

function clearSessionFileMutations(
  sessionId: string,
  messages: readonly UIMessage[],
): void {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts as AnyPart[]) {
      const candidate = part as unknown as {
        type?: string;
        toolName?: string;
        toolCallId?: string;
      };
      const toolName =
        candidate.type === "dynamic-tool"
          ? candidate.toolName
          : candidate.type?.replace(/^tool-/, "");
      if (candidate.toolCallId && toolName && isFileMutation(toolName)) {
        clearPreparedFileMutation(sessionId, candidate.toolCallId);
      }
    }
  }
}

function isFileMutation(
  toolName: string,
): toolName is "write_file" | "edit" | "multi_edit" {
  return (
    toolName === "write_file" ||
    toolName === "edit" ||
    toolName === "multi_edit"
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
