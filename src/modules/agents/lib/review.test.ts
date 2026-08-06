/**
 * 本文件验证托管 Agent 自动审查统一经过聊天发送入口。
 * 测试锁定运行冲突时保留待审查状态，成功接受后才标记本轮已审查。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@/modules/ai/store/chatRuntime", () => ({
  sendChatMessage: runtime.send,
}));

import { firePendingReviewForSession } from "./review";
import { useManagedAgentsStore } from "../store/managedAgentsStore";

const sessionId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  runtime.send.mockReset();
  useManagedAgentsStore.setState({ agents: {} });
  useManagedAgentsStore.getState().register({
    tabId: 7,
    sessionId,
    task: "Inspect the change",
    cwd: null,
  });
  useManagedAgentsStore.getState().setPendingReview(7, true);
});

describe("managed agent review dispatch", () => {
  it("marks the round reviewed only after the chat accepts it", async () => {
    runtime.send.mockResolvedValue(true);

    firePendingReviewForSession(sessionId);
    await vi.waitFor(() => {
      expect(useManagedAgentsStore.getState().get(7)?.phase).toBe("reviewing");
    });

    expect(runtime.send).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ role: "user" }),
    );
    expect(useManagedAgentsStore.getState().get(7)).toMatchObject({
      reviewedAtRound: 0,
      pendingReview: false,
    });
  });

  it("keeps a rejected review pending for the next unlocked state", async () => {
    runtime.send.mockResolvedValue(false);

    firePendingReviewForSession(sessionId);
    await vi.waitFor(() => {
      expect(runtime.send).toHaveBeenCalledOnce();
    });

    expect(useManagedAgentsStore.getState().get(7)).toMatchObject({
      reviewedAtRound: -1,
      pendingReview: true,
    });
  });

  it("keeps a failed review pending without leaking a rejected promise", async () => {
    runtime.send.mockRejectedValue(new Error("lock unavailable"));

    firePendingReviewForSession(sessionId);
    await vi.waitFor(() => {
      expect(runtime.send).toHaveBeenCalledOnce();
    });

    expect(useManagedAgentsStore.getState().get(7)).toMatchObject({
      reviewedAtRound: -1,
      pendingReview: true,
    });
  });
});
