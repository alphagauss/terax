/**
 * 本文件测试按会话隔离的工具审批状态。
 * 测试锁定跨会话相同审批 ID 的路由和单次响应不变量。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalRequestKey, useApprovalStore } from "./approvalStore";

const request = {
  approvalId: "approval-1",
  toolCallId: "tool-1",
  toolName: "bash_run",
  input: { command: "pnpm test" },
};

describe("approval store", () => {
  beforeEach(() => {
    useApprovalStore.setState({ requests: {}, responders: {} });
  });

  it("routes identical approval IDs to their owning sessions", () => {
    const first = vi.fn();
    const second = vi.fn();
    const store = useApprovalStore.getState();
    store.registerResponder("session-a", first);
    store.registerResponder("session-b", second);
    store.syncSessionRequests("session-a", [
      { ...request, sessionId: "session-a" },
    ]);
    store.syncSessionRequests("session-b", [
      { ...request, sessionId: "session-b" },
    ]);

    expect(
      useApprovalStore
        .getState()
        .respond(approvalRequestKey("session-a", request.approvalId), true),
    ).toBe(true);
    expect(first).toHaveBeenCalledWith(request.approvalId, true);
    expect(second).not.toHaveBeenCalled();

    expect(
      useApprovalStore
        .getState()
        .respond(approvalRequestKey("session-b", request.approvalId), false),
    ).toBe(true);
    expect(second).toHaveBeenCalledWith(request.approvalId, false);
  });

  it("responds to one request at most once", () => {
    const responder = vi.fn();
    const store = useApprovalStore.getState();
    store.registerResponder("session-a", responder);
    store.syncSessionRequests("session-a", [
      { ...request, sessionId: "session-a" },
    ]);
    const key = approvalRequestKey("session-a", request.approvalId);

    expect(useApprovalStore.getState().respond(key, true)).toBe(true);
    expect(useApprovalStore.getState().respond(key, false)).toBe(false);
    expect(responder).toHaveBeenCalledOnce();
  });
});
