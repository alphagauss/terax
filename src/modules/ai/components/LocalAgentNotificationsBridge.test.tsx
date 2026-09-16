// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionAttentionStore } from "../store/sessionAttentionStore";

const mocks = vi.hoisted(() => ({
  route: vi.fn(),
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
vi.mock("@/modules/agents/lib/useWindowFocus", () => ({
  useWindowFocus: () => true,
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
