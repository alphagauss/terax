import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "./agentStore";

describe("agentStore notifications", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAgentStore.setState({ notifications: [] });
  });

  it("同一会话只保留最新通知，不合并其他会话", () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(300);
    const store = useAgentStore.getState();

    store.pushNotification({
      source: "local",
      tabId: 0,
      sessionId: "session-1",
      agent: "Terax",
      kind: "attention",
    });
    store.pushNotification({
      source: "local",
      tabId: 0,
      sessionId: "session-1",
      agent: "Terax",
      kind: "finished",
    });
    store.pushNotification({
      source: "local",
      tabId: 0,
      sessionId: "other-session",
      agent: "Terax",
      kind: "finished",
    });

    expect(useAgentStore.getState().notifications).toMatchObject([
      { sessionId: "other-session", kind: "finished" },
      { sessionId: "session-1", kind: "finished", at: 200, read: false },
    ]);
  });

  it("按通知或会话目标移除已查看通知", () => {
    const store = useAgentStore.getState();
    store.pushNotification({
      source: "terminal",
      tabId: 7,
      agent: "claude",
      kind: "finished",
    });
    store.pushNotification({
      source: "local",
      tabId: 0,
      sessionId: "session-1",
      agent: "Terax",
      kind: "finished",
    });
    store.pushNotification({
      source: "local",
      tabId: 0,
      sessionId: "session-2",
      agent: "Terax",
      kind: "finished",
    });

    const localId =
      useAgentStore
        .getState()
        .notifications.find(
          (notification) => notification.sessionId === "session-1",
        )?.id ?? "";
    expect(localId).not.toBe("");
    store.dismissNotification(localId);
    store.dismissNotificationsForTarget({ source: "terminal", tabId: 7 });

    expect(useAgentStore.getState().notifications).toMatchObject([
      { source: "local", sessionId: "session-2" },
    ]);
  });
});
