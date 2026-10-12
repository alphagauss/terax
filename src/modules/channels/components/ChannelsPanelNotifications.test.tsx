// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeliveryDisplay } from "@/modules/channels/history";
import type { UIMessage } from "ai";
import { Chat } from "@ai-sdk/react";
import { ChannelConversation } from "@/modules/channels/components/ChannelConversation";
import { useCommandStore } from "@/modules/ai/commands/store";
import { useDeliveryHistory } from "@/modules/channels/history";
import { runFailureMessage } from "@/modules/ai/lib/conversation";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  useDeliveryHistory.setState({ sessions: {}, pending: {} });
  useCommandStore.setState({ sessions: {} });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("正文变更和删除即时同步，思考空白不撑高卡片，模型错误不重复显示", async () => {
  vi.useFakeTimers();
  const user: UIMessage = {
    id: "user",
    role: "user",
    parts: [{ type: "text", text: "question" }],
    metadata: { createdAt: 1 },
  };
  const reply: UIMessage = {
    id: "reply",
    role: "assistant",
    parts: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "\n\n" },
      { type: "step-start" },
      { type: "text", text: "\n\nold answer\n\nsecond paragraph\n" },
    ],
    metadata: { createdAt: 2 },
  };
  const chat = new Chat<UIMessage>({ id: "live", messages: [user, reply] });
  useDeliveryHistory.setState({
    sessions: {
      live: [
        {
          id: "delivery",
          phase: "request",
          source: "agent",
          timestamp: 3,
          target: { kind: "direct", id: "owner" },
          content: { text: "old answer" },
          afterMessageId: "reply",
          result: { status: "failed", parts: [] },
          notification: { status: "error" },
        },
      ],
    },
    pending: {},
  });
  useCommandStore.setState({ sessions: {} });
  await act(async () =>
    root.render(
      <ChannelConversation
        chat={chat}
        sessionId="live"
        connectionId="connection"
        canRetry
      />,
    ),
  );
  expect(container.querySelectorAll(".app-scrollbar p")[1].textContent).toBe(
    "old answer\n\nsecond paragraph",
  );
  expect(chat.messages[1].parts).toEqual(reply.parts);
  await act(async () => {
    chat.messages = [
      user,
      { ...reply, parts: [{ type: "text", text: "edited answer" }] },
    ];
    await vi.runAllTimersAsync();
  });
  const viewport = container.querySelector(".app-scrollbar");
  expect(viewport?.textContent).toContain("edited answer");
  expect(viewport?.textContent).not.toContain("old answer");
  await act(async () => {
    chat.messages = [user];
    await vi.runAllTimersAsync();
  });
  expect(viewport?.textContent).not.toContain("edited answer");
  expect(container.querySelector("summary")).toBeNull();
  expect(
    container.querySelector('[data-conversation-message-id="delivery"]'),
  ).toBeNull();
  await act(async () => {
    chat.messages = [
      user,
      { ...reply, id: "new", parts: [{ type: "text", text: "new answer" }] },
    ];
    useCommandStore.setState({
      sessions: { live: [{ id: "command", input: "/help", timestamp: 4 }] },
    });
    useDeliveryHistory.setState({ sessions: { live: [] } });
    await vi.runAllTimersAsync();
  });
  expect(viewport?.textContent).toContain("new answer");
  expect(viewport?.textContent).toContain("/help");
  await act(async () => {
    chat.messages = [];
    useCommandStore.setState({ sessions: {} });
    await vi.runAllTimersAsync();
  });
  expect(viewport?.textContent).toBe("");
  const failure = runFailureMessage(
    { version: 1, event: "run_failure", error: "connection reset" },
    "turn",
    1000,
  );
  const notice: DeliveryDisplay = {
    id: "notice",
    phase: "request",
    source: "system",
    timestamp: 2000,
    target: { kind: "direct", id: "owner" },
    content: { text: "模型请求失败：connection reset" },
    afterMessageId: failure.id,
    result: { status: "accepted", parts: [] },
  };
  await act(async () => {
    chat.messages = [failure];
    useDeliveryHistory.setState({
      sessions: { live: [notice] },
    });
    await vi.runAllTimersAsync();
  });
  expect(container.textContent?.match(/connection reset/g)).toHaveLength(1);
  expect(container.querySelector(".text-destructive")?.textContent).toContain(
    "connection reset",
  );
  expect(container.textContent).toContain("outbound.accepted");
  expect(container.textContent).not.toContain("outbound.sources.system");
  expect(container.textContent).not.toContain("outbound.sources.agent");
  expect(
    container
      .querySelector('[data-conversation-message-id="notice"]')
      ?.classList.contains("border"),
  ).toBe(false);
});

const io = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("react-i18next", () => {
  const t = (key: string, args?: { count?: number; error?: string }) =>
    args ? `${key}:${args.count ?? args.error}` : key;
  return { useTranslation: () => ({ t, i18n: { language: "en" } }) };
});
vi.mock("@/modules/channels/client", async (original) => ({
  ...(await original<typeof import("@/modules/channels/client")>()),
  requestChannels: io.request,
}));

it("汇总定位当前会话问题，忽略更新计数，重发新增卡片，忽略全部只提交剩余问题", async () => {
  let entries: DeliveryDisplay[] = ["first", "second"].map((id) => ({
    id,
    phase: "request",
    source: "application",
    timestamp: 0,
    target: { kind: "direct", id: "owner" },
    content: { text: id },
    result: { status: "failed", parts: [] },
    notification: { status: "error" },
  }));
  io.request.mockImplementation(async (action) => {
    if (action.action === "dismiss-deliveries") {
      entries = entries.map((entry) =>
        action.deliveryIds.includes(entry.id)
          ? { ...entry, notification: { status: "ignored" } }
          : entry,
      );
    } else {
      const original = entries[1];
      expect(action.deliveryId).toBe(original.id);
      entries = entries.map((entry) =>
        entry === original
          ? { ...entry, notification: { status: "retried", retryId: "retry" } }
          : entry,
      );
      entries.push({ ...original, id: "retry", retryOf: original.id });
    }
    useDeliveryHistory.setState({ sessions: { session: entries } });
  });
  const scroll = vi
    .spyOn(HTMLElement.prototype, "scrollIntoView")
    .mockImplementation(() => {});
  const chat = new Chat<UIMessage>({ id: "session", messages: [] });
  useDeliveryHistory.setState({
    sessions: { session: entries },
    pending: {},
  });
  const card = (id: string) =>
    container.querySelector<HTMLElement>(
      `[data-conversation-message-id="${id}"]`,
    );
  await act(async () =>
    root.render(
      <ChannelConversation
        chat={chat}
        sessionId="session"
        connectionId="connection"
        canRetry
      />,
    ),
  );
  expect(container.querySelector("summary")?.textContent).toBe(
    "outbound.issues:2",
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>("details button")?.click(),
  );
  expect(scroll.mock.instances[0]).toBe(card("first"));
  await act(async () => card("first")?.querySelector("button")?.click());
  expect(card("first")?.textContent).toContain("outbound.ignored");
  expect(card("first")?.querySelector("button")).toBeNull();
  expect(card("first")?.className).not.toContain("border-destructive");
  expect(container.querySelector("summary")?.textContent).toBe(
    "outbound.issues:1",
  );
  await act(async () => card("second")?.querySelectorAll("button")[1]?.click());
  expect(card("second")?.textContent).toContain("outbound.retried");
  expect(card("second")?.querySelector("button")).toBeNull();
  expect(card("second")?.className).not.toContain("border-destructive");
  expect(card("retry")).not.toBeNull();
  const ignoreAll = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "outbound.ignoreAll",
  );
  await act(async () => ignoreAll?.click());
  expect(io.request).toHaveBeenLastCalledWith({
    action: "dismiss-deliveries",
    id: "connection",
    sessionId: "session",
    deliveryIds: ["retry"],
  });
  expect(container.querySelector("summary")).toBeNull();
});
