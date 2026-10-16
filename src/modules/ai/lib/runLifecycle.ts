/**
 * 本文件协调单次 Agent 运行的审批和终态提交。
 * 直接订阅 SDK 状态，不依赖 React 挂载；持久化失败由宿主报告并保留运行所有权。
 */

import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { TOOL_APPROVAL_DENIED_REASON } from "@/modules/ai/lib/conversation";
import { shouldCommitSession } from "@/modules/ai/lib/sessionLifecycle";
import { clearAgentTurnCoordinator } from "@/modules/ai/agents/subagentRuntime";
import { clearSessionProcesses } from "@/modules/ai/lib/sessions";

const stoppingRuns = new WeakMap<Chat<UIMessage>, Promise<void>>();

/**
 * 中止模型并立即终止活跃执行的进程，保留已结束执行的后台服务，等待子任务与 SDK 收敛后清理审批状态。
 * 停止期间禁止终态提交，避免会话解锁早于原生资源清理。
 */
export function cancelAgentRun(
  chat: Chat<UIMessage>,
  sessionId: string,
): Promise<void> {
  const existing = stoppingRuns.get(chat);
  if (existing) return existing;
  const operation = Promise.resolve()
    .then(async () => {
      const idle = new Promise<void>((resolve) => {
        if (chat.status !== "streaming" && chat.status !== "submitted") {
          resolve();
          return;
        }
        const unsubscribe = chat["~registerStatusCallback"](() => {
          if (chat.status === "streaming" || chat.status === "submitted")
            return;
          unsubscribe();
          resolve();
        });
      });
      await chat.stop();
      const childrenStopped = clearAgentTurnCoordinator(sessionId);
      await clearSessionProcesses(sessionId, childrenStopped, "active");
      await idle;
    })
    .then(
      () => {
        stoppingRuns.delete(chat);
        // 直接收敛审批记录，不调用自动续传入口；新消息通知唤醒终态提交。
        chat.messages = chat.messages.map((message) => ({
          ...message,
          parts: message.parts.map((part) => {
            if (!("state" in part) || part.state !== "approval-requested")
              return part;
            return {
              ...part,
              state: "output-denied",
              approval: {
                ...part.approval,
                approved: false,
                reason: TOOL_APPROVAL_DENIED_REASON,
              },
            };
          }),
        })) as UIMessage[];
      },
      (error: unknown) => {
        stoppingRuns.delete(chat);
        throw error;
      },
    );
  stoppingRuns.set(chat, operation);
  return operation;
}

export type PendingApproval = {
  sessionId: string;
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type RunStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "awaiting-approval"
  | "error";

type Dependencies = {
  sessionId: string;
  isOwned: () => boolean;
  onApprovals: (requests: PendingApproval[]) => void;
  onStatus: (status: RunStatus, approvalsPending: number) => void;
  onMessages: (messages: UIMessage[]) => void;
  commit: (messages: UIMessage[]) => Promise<void>;
  onError: (error: unknown) => void;
};

/** 提取当前待审批操作，保留完整工具调用身份供各端展示与回答。 */
export function collectPendingApprovals(
  sessionId: string,
  messages: readonly UIMessage[],
): PendingApproval[] {
  const requests: PendingApproval[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!("state" in part) || part.state !== "approval-requested") continue;
      if (
        !("approval" in part) ||
        !part.approval?.id ||
        !("toolCallId" in part)
      )
        continue;
      const input = "input" in part ? part.input : undefined;
      requests.push({
        sessionId,
        approvalId: part.approval.id,
        toolCallId: part.toolCallId,
        toolName:
          part.type === "dynamic-tool"
            ? part.toolName
            : part.type.replace(/^tool-/, ""),
        input:
          input && typeof input === "object"
            ? (input as Record<string, unknown>)
            : {},
      });
    }
  }
  return requests;
}

/**
 * 绑定一次运行的生命周期；宿主在释放运行所有权后调用 dispose。
 * 合并同一轮事件循环的通知，让 SDK 完成审批自动续传后再判断终态，避免提前解锁。
 */
export function observeAgentRun(chat: Chat<UIMessage>, deps: Dependencies) {
  let disposed = false;
  let committing = false;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previousMessages: UIMessage[] | undefined;
  let previousStatus: RunStatus | undefined;
  let approvalKey = "";
  let previousApprovalCount = -1;

  const update = () => {
    timer = undefined;
    if (disposed || !deps.isOwned() || stoppingRuns.has(chat)) return;
    const messages = chat.messages;
    const approvals = collectPendingApprovals(deps.sessionId, messages);
    const nextKey = JSON.stringify(
      approvals.map((request) => request.approvalId),
    );
    if (nextKey !== approvalKey) {
      approvalKey = nextKey;
      deps.onApprovals(approvals);
    }
    const status: RunStatus = approvals.length
      ? "awaiting-approval"
      : chat.status === "submitted"
        ? "thinking"
        : chat.status === "streaming"
          ? "streaming"
          : chat.status === "error"
            ? "error"
            : "idle";
    if (
      status !== previousStatus ||
      approvals.length !== previousApprovalCount
    ) {
      previousStatus = status;
      previousApprovalCount = approvals.length;
      deps.onStatus(status, approvals.length);
    }
    if (messages !== previousMessages) {
      previousMessages = messages;
      deps.onMessages(messages);
    }
    if (
      committing ||
      failed ||
      !shouldCommitSession(chat.status, approvals.length, deps.isOwned())
    )
      return;
    committing = true;
    void deps
      .commit(messages)
      .catch((error: unknown) => {
        failed = true;
        deps.onError(error);
      })
      .finally(() => {
        committing = false;
      });
  };
  const schedule = () => {
    if (!disposed && timer === undefined) timer = setTimeout(update, 0);
  };
  const subscriptions = [
    chat["~registerMessagesCallback"](schedule),
    chat["~registerStatusCallback"](schedule),
    chat["~registerErrorCallback"](schedule),
  ];
  schedule();
  return {
    respond: (approvalId: string, approved: boolean) =>
      chat.addToolApprovalResponse({
        id: approvalId,
        approved,
        ...(approved ? {} : { reason: TOOL_APPROVAL_DENIED_REASON }),
      }),
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const unsubscribe of subscriptions) unsubscribe();
    },
  };
}
