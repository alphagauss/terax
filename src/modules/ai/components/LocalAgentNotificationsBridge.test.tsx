// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionAttentionStore } from "../store/sessionAttentionStore";

const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  dismiss: vi.fn(),
  setLocalAgent: vi.fn(),
  focused: true,
  state: {
    agentMetaBySession: {},
    sessions: [],
    activeSessionId: null,
    runLockSessionIds: {},
  } as {
    agentMetaBySession: Record<string, { status: "ready"; error?: string }>;
    sessions: Array<{ id: string; title: string; channelId?: string }>;
    activeSessionId: string | null;
    runLockSessionIds: Record<string, true>;
  },
}));

vi.mock("@/modules/agents/lib/route", () => ({
  routeAgentNotification: mocks.route,
}));
vi.mock("@/modules/agents/store/agentStore", () => ({
  useAgentStore: {
    getState: () => ({
      dismissNotificationsForTarget: mocks.dismiss,
      setLocalAgent: mocks.setLocalAgent,
    }),
  },
}));
vi.mock("@/modules/agents/lib/useWindowFocus", () => ({
  useWindowFocus: () => mocks.focused,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../store/chatStore", () => ({
  sessionMetadata: new Map(),
  useChatStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}));

import { LocalAgentNotificationsBridge } from "./LocalAgentNotificationsBridge";

let root: Root;

beforeEach(() => {
  mocks.route.mockReset();
  mocks.dismiss.mockReset();
  mocks.setLocalAgent.mockReset();
  mocks.focused = true;
  mocks.state.agentMetaBySession = {};
  mocks.state.sessions = [
    { id: "regular", title: "Regular" },
    { id: "channel", title: "Channel", channelId: "connection" },
  ];
  mocks.state.activeSessionId = null;
  mocks.state.runLockSessionIds = {};
  useSessionAttentionStore.setState({
    bySession: { channel: "completed-unread" },
    revealLatestBySession: {},
    pendingCompletions: [
      { sessionId: "regular", outcome: "completed" },
      { sessionId: "channel", outcome: "error" },
    ],
  });
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
});

it("只为普通 AI 会话发送完成通知", async () => {
  await act(async () => {
    root.render(
      <LocalAgentNotificationsBridge visible={false} onActivate={() => {}} />,
    );
  });

  expect(mocks.route).toHaveBeenCalledOnce();
  expect(mocks.route).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: "regular", kind: "finished" }),
  );
  expect(useSessionAttentionStore.getState().bySession.channel).toBeUndefined();
});

it("查看会话时消费该会话的通知", async () => {
  mocks.state.activeSessionId = "regular";

  await act(async () => {
    root.render(
      <LocalAgentNotificationsBridge visible={true} onActivate={() => {}} />,
    );
  });

  expect(mocks.dismiss).toHaveBeenCalledWith({
    source: "local",
    sessionId: "regular",
  });

  mocks.dismiss.mockClear();
  mocks.state.activeSessionId = "channel";
  await act(async () => {
    root.render(
      <LocalAgentNotificationsBridge visible={true} onActivate={() => {}} />,
    );
  });

  expect(mocks.dismiss).toHaveBeenCalledWith({
    source: "local",
    sessionId: "channel",
  });
});

it("AI 面板不可见时不消费活动会话通知", async () => {
  mocks.state.activeSessionId = "regular";

  await act(async () => {
    root.render(
      <LocalAgentNotificationsBridge visible={false} onActivate={() => {}} />,
    );
  });

  expect(mocks.dismiss).not.toHaveBeenCalled();
});

it.each([
  { visible: true, activeSessionId: "regular", consumed: true },
  { visible: true, activeSessionId: "channel", consumed: false },
  { visible: false, activeSessionId: "regular", consumed: false },
])(
  "后台完成后恢复焦点只消费正在查看的会话：$visible / $activeSessionId",
  async ({ visible, activeSessionId, consumed }) => {
    mocks.state.activeSessionId = "regular";
    mocks.state.runLockSessionIds = { regular: true };
    useSessionAttentionStore.setState({
      bySession: {},
      pendingCompletions: [],
    });
    const onActivate = vi.fn();
    const render = () =>
      root.render(
        <LocalAgentNotificationsBridge
          visible={visible}
          onActivate={onActivate}
        />,
      );

    await act(async () => render());
    mocks.dismiss.mockClear();

    mocks.focused = false;
    await act(async () => render());
    expect(useSessionAttentionStore.getState().bySession.regular).toBe(
      "background-running",
    );

    await act(async () => {
      useSessionAttentionStore.getState().finalizeRun("regular", "completed");
      mocks.state.runLockSessionIds = {};
      mocks.state.activeSessionId = activeSessionId;
      render();
    });
    expect(mocks.dismiss).not.toHaveBeenCalled();
    expect(mocks.route).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "regular",
        kind: "finished",
        focused: false,
      }),
    );
    expect(useSessionAttentionStore.getState().bySession.regular).toBe(
      "completed-unread",
    );

    mocks.focused = true;
    await act(async () => render());
    if (visible) {
      expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith({
        source: "local",
        sessionId: activeSessionId,
      });
    } else {
      expect(mocks.dismiss).not.toHaveBeenCalled();
    }
    expect(useSessionAttentionStore.getState().bySession.regular).toBe(
      consumed ? undefined : "completed-unread",
    );
  },
);
