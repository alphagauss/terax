import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: false,
  push: vi.fn(),
  native: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ agentNotifications: mocks.enabled }),
  },
}));
vi.mock("../store/agentStore", () => ({
  useAgentStore: { getState: () => ({ pushNotification: mocks.push }) },
}));
vi.mock("../components/AgentToast", () => ({ showAgentToast: mocks.toast }));
vi.mock("@/modules/notifications/client", () => ({ osNotify: mocks.native }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.enabled = false;
});

it.each([true, false])(
  "关闭提醒仍保存后台通知，且不主动投递：focused=%s",
  async (focused) => {
    const { routeAgentNotification } = await import("./route");
    const event = {
      source: "terminal" as const,
      agent: "claude",
      kind: "attention" as const,
      title: "需要输入",
      focused,
      visible: false,
      allowToast: true,
      tabId: 1,
      onActivate: vi.fn(),
    };
    routeAgentNotification(event);
    expect(mocks.push).toHaveBeenCalledOnce();
    expect(mocks.native).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();

    mocks.enabled = true;
    routeAgentNotification({ ...event, tabId: 2 });
    expect(focused ? mocks.toast : mocks.native).toHaveBeenCalledOnce();
    if (!focused) {
      expect(mocks.native).toHaveBeenCalledWith("需要输入", "claude", {
        window: "main",
        target: { module: "terminal", tabId: 2 },
      });
      routeAgentNotification({
        ...event,
        source: "local",
        sessionId: "session-7",
      });
      expect(mocks.native).toHaveBeenLastCalledWith("需要输入", "claude", {
        window: "main",
        target: { module: "ai", sessionId: "session-7" },
      });
    }
  },
);
