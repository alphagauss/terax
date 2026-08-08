// @vitest-environment happy-dom
/**
 * 本文件测试 AI 后台运行桥接器的外部状态订阅。
 * 测试锁定空运行集合在 React 严格模式下保持稳定快照，避免启动时无限渲染。
 */

import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../store/chatRuntime", () => ({
  getOrCreateChat: () => {
    throw new Error("空运行集合不应创建 Chat 实例");
  },
}));

import { useChatStore } from "../store/chatStore";
import { AgentRunBridge } from "./AgentRunBridge";

afterEach(() => {
  useChatStore.setState({ runLockSessionIds: {} });
  document.body.replaceChildren();
});

describe("AgentRunBridge", () => {
  it("mounts with an empty run set without entering an update loop", async () => {
    useChatStore.setState({ runLockSessionIds: {} });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <AgentRunBridge />
        </StrictMode>,
      );
    });

    expect(container.childNodes).toHaveLength(0);

    await act(async () => root.unmount());
  });
});
