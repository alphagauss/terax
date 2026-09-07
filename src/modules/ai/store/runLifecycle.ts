/**
 * 本文件将共享 Agent 生命周期接入桌面会话状态和审批展示。
 * 订阅随运行锁创建与销毁，不依赖任何 React 组件，文件预览只为待审批调用准备一次。
 */

import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { observeAgentRun } from "@/modules/ai/lib/runLifecycle";
import { useApprovalStore } from "@/modules/ai/store/approvalStore";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  clearTerminalFileMutations,
  clearSessionFileMutations,
  isFileMutation,
  prepareFileMutation,
} from "@/modules/ai/tools/fileMutation";

/** 在取得运行锁后绑定会话，释放锁时同步解除订阅并清理预备修改。 */
export function startDesktopRunLifecycle(
  sessionId: string,
  chat: Chat<UIMessage>,
): void {
  let disposed = false;
  const lifecycle = observeAgentRun(chat, {
    sessionId,
    isOwned: () =>
      Boolean(useChatStore.getState().runLockSessionIds[sessionId]),
    onApprovals: (approvals) => {
      useApprovalStore.getState().syncSessionRequests(sessionId, approvals);
      const cwd = useChatStore
        .getState()
        .sessions.find((session) => session.id === sessionId)?.cwd;
      if (!cwd) return;
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
          // 预览读取允许覆盖本次待批准范围，实际提交仍等待审批决定。
          permissionMode: "full-access",
        })
          .then((preview) => {
            if (!disposed) useApprovalStore.getState().setPreview(key, preview);
          })
          .catch((error: unknown) => {
            if (!disposed)
              useApprovalStore.getState().setPreview(key, null, String(error));
          });
      }
    },
    onStatus: (status, approvalsPending) =>
      useChatStore.getState().patchAgentMeta(sessionId, {
        status,
        approvalsPending,
        ...(status === "idle" || status === "error" ? { step: null } : {}),
        ...(status === "idle" ? { error: null } : {}),
      }),
    onMessages: (messages) => clearTerminalFileMutations(sessionId, messages),
    commit: (messages) =>
      useChatStore.getState().commitMessages(sessionId, messages),
    onError: (error) =>
      useChatStore.setState({ sessionSyncError: String(error) }),
  });
  useApprovalStore.getState().registerResponder(sessionId, lifecycle.respond);
  const unsubscribe = useChatStore.subscribe((state) => {
    if (state.runLockSessionIds[sessionId]) return;
    disposed = true;
    unsubscribe();
    lifecycle.dispose();
    useApprovalStore.getState().clearSession(sessionId);
    clearSessionFileMutations(sessionId, chat.messages);
  });
}
