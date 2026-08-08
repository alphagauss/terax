/**
 * 本文件测试 AI 会话纯内存关注状态。
 * 重点锁定后台完成、失败、取消、查看清除和完成事件单次消费等不变量。
 */

import { afterEach, describe, expect, it } from "vitest";
import { useSessionAttentionStore } from "./sessionAttentionStore";

afterEach(() => {
  useSessionAttentionStore.setState({
    bySession: {},
    revealLatestBySession: {},
    pendingCompletions: [],
  });
});

describe("sessionAttentionStore", () => {
  it("keeps completed background sessions unread until viewed", () => {
    const store = useSessionAttentionStore.getState();
    store.markBackgroundRunning("s1");
    store.finalizeRun("s1", "completed");

    expect(useSessionAttentionStore.getState().bySession.s1).toBe(
      "completed-unread",
    );

    useSessionAttentionStore.getState().markViewed("s1");
    expect(useSessionAttentionStore.getState().bySession.s1).toBeUndefined();
  });

  it("marks failures and clears user-cancelled runs", () => {
    const store = useSessionAttentionStore.getState();
    store.markBackgroundRunning("failed");
    store.markBackgroundRunning("cancelled");
    store.finalizeRun("failed", "error");
    store.finalizeRun("cancelled", "cancelled");

    expect(useSessionAttentionStore.getState().bySession).toEqual({
      failed: "error-unread",
    });
    expect(useSessionAttentionStore.getState().pendingCompletions).toEqual([
      { sessionId: "failed", outcome: "error" },
    ]);
  });

  it("consumes completion events only once", () => {
    useSessionAttentionStore.getState().finalizeRun("s1", "completed");

    expect(
      useSessionAttentionStore.getState().takePendingCompletions(),
    ).toEqual([{ sessionId: "s1", outcome: "completed" }]);
    expect(
      useSessionAttentionStore.getState().takePendingCompletions(),
    ).toEqual([]);
  });

  it("keeps reveal requests until the visible conversation consumes them", () => {
    const store = useSessionAttentionStore.getState();
    store.requestRevealLatest("s1");

    expect(useSessionAttentionStore.getState().takeRevealLatest("s1")).toBe(
      true,
    );
    expect(useSessionAttentionStore.getState().takeRevealLatest("s1")).toBe(
      false,
    );
  });
});
