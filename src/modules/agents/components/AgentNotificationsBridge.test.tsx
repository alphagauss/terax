// @vitest-environment happy-dom

/**
 * 本文件测试终端 Agent 信号到活动状态和通知的桥接。
 * 锁定通用 PTY Agent 通知不依赖托管编码 Agent 状态机。
 */

import type { Tab } from "@/modules/workbench";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "../store/agentStore";

type SignalHandler = (event: {
  payload: { id: number; kind: string; agent: string | null };
}) => void;

const mocks = vi.hoisted(() => ({
  handler: null as SignalHandler | null,
  route: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: SignalHandler) => {
    mocks.handler = handler;
    return Promise.resolve(() => {});
  }),
}));

vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

vi.mock("@/modules/terminal", () => ({
  terminalIdForPty: (id: number) => id,
}));

vi.mock("../lib/route", () => ({
  routeAgentNotification: mocks.route,
}));

vi.mock("../lib/useWindowFocus", () => ({
  useWindowFocus: () => true,
}));

import { AgentNotificationsBridge } from "./AgentNotificationsBridge";

describe("AgentNotificationsBridge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    mocks.handler = null;
    mocks.route.mockReset();
    useAgentStore.setState({
      sessions: {},
      localAgent: null,
      notifications: [],
    });
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root.render(
        <AgentNotificationsBridge
          tabs={[
            { id: 7, kind: "terminal", title: "Claude" } as unknown as Tab,
          ]}
          activeId={99}
          onActivate={() => {}}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("独立处理终端 Agent 的启动、完成和退出信号", () => {
    const emit = (kind: string, agent: string | null = null) =>
      mocks.handler?.({ payload: { id: 7, kind, agent } });

    act(() => emit("started", "claude"));
    expect(useAgentStore.getState().sessions[7]).toMatchObject({
      agent: "claude",
      status: "working",
    });

    act(() => emit("finished"));
    expect(useAgentStore.getState().sessions[7]?.status).toBe("waiting");
    expect(mocks.route).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "finished", tabId: 7 }),
    );

    act(() => emit("exited"));
    expect(useAgentStore.getState().sessions[7]).toBeUndefined();
  });
});
