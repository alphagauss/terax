// @vitest-environment happy-dom
/**
 * 本文件测试 AI 侧栏的会话订阅和后台运行边界。
 * 测试锁定 Chat 实例更换后重新订阅，且侧栏不拥有后台运行生命周期。
 */

import { Chat, type UIMessage } from "@ai-sdk/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ chat: null as Chat<UIMessage> | null }));

vi.mock("../store/chatRuntime", () => ({
  loadChat: async () => runtime.chat,
}));
vi.mock("@/modules/workspace-process", () => ({
  currentWorkspaceBootstrap: () => ({ environmentKey: "local" }),
}));
vi.mock("./AiChat", () => ({
  AiChatView: ({ messages }: { messages: UIMessage[] }) => (
    <div data-testid="messages">
      {messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("|")}
    </div>
  ),
}));
vi.mock("./AiSidebarComposer", () => ({ AiSidebarComposer: () => null }));
vi.mock("./AiInputBar", () => ({ AiInputBarConnect: () => null }));

import { useCommandStore } from "@/modules/ai/commands/store";
import { useChatStore } from "../store/chatStore";
import { AiSidebarPanel } from "./AiSidebarPanel";

const sessionId = "11111111-1111-4111-8111-111111111111";
const transport = {
  sendMessages: async () => new ReadableStream(),
  reconnectToStream: async () => null,
};

function message(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function chat(messages: UIMessage[]): Chat<UIMessage> {
  return new Chat({ id: sessionId, messages, transport });
}

afterEach(() => {
  runtime.chat = null;
  useCommandStore.setState({ sessions: {} });
  document.body.replaceChildren();
});

describe("AI sidebar chat subscription", () => {
  it("只有命令记录时也挂载会话时间线", async () => {
    runtime.chat = chat([]);
    useChatStore.setState({
      activeSessionId: sessionId,
      sessions: [],
      runLockSessionIds: {},
    });
    useCommandStore.setState({
      sessions: { [sessionId]: [{ id: "help", input: "/help", timestamp: 0 }] },
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<AiSidebarPanel hasComposer visible />));
    expect(container.querySelector('[data-testid="messages"]')).not.toBeNull();
    await act(async () => root.unmount());
  });
  it("unsubscribes hidden messages and resumes the same running Chat", async () => {
    const current = chat([message("m1", "first")]);
    runtime.chat = current;
    useChatStore.setState({
      activeSessionId: sessionId,
      sessions: [],
      runLockSessionIds: { [sessionId]: true },
    });
    let listeners = 0;
    const subscribe = current["~registerMessagesCallback"];
    current["~registerMessagesCallback"] = (callback, throttle) => {
      listeners++;
      const unsubscribe = subscribe(callback, throttle);
      return () => {
        listeners--;
        unsubscribe();
      };
    };
    const stop = vi.spyOn(current, "stop");
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<AiSidebarPanel hasComposer visible />));
    expect(listeners).toBe(1);
    await act(async () =>
      root.render(<AiSidebarPanel hasComposer visible={false} />),
    );
    expect(listeners).toBe(0);
    expect(container.querySelector('[data-testid="messages"]')).toBeNull();
    current.messages = [message("m2", "background result")];
    await act(async () => root.render(<AiSidebarPanel hasComposer visible />));
    expect(container.textContent).toContain("background result");
    expect(listeners).toBe(1);
    expect(stop).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(listeners).toBe(0);
  });
  it("re-subscribes when the active revision replaces a same-id Chat", async () => {
    runtime.chat = chat([message("m1", "first")]);
    useChatStore.setState({
      activeSessionId: sessionId,
      activeSessionRevision: 0,
      sessions: [],
      runLockSessionIds: {},
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<AiSidebarPanel hasComposer visible />);
    });
    expect(container.textContent).toContain("first");

    runtime.chat = chat([message("m2", "second")]);
    await act(async () => {
      useChatStore.setState({ activeSessionRevision: 1 });
    });
    expect(container.textContent).toContain("second");

    await act(async () => {
      if (!runtime.chat) throw new Error("missing test Chat");
      runtime.chat.messages = [
        ...runtime.chat.messages,
        message("m3", "third"),
      ];
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    });
    expect(container.textContent).toContain("third");

    await act(async () => root.unmount());
  });
});
