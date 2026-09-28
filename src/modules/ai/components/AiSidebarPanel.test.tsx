// @vitest-environment happy-dom
/**
 * 本文件测试 AI 侧栏的会话订阅和后台运行边界。
 * 测试锁定 Chat 实例更换后重新订阅，且侧栏不拥有后台运行生命周期。
 */

import { preloadEn } from "@/i18n";
import { Chat, type UIMessage } from "@ai-sdk/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ chat: null as Chat<UIMessage> | null }));
const sessionSearch = vi.hoisted(() => vi.fn());

vi.mock("../store/chatRuntime", () => ({
  loadChat: async () => runtime.chat,
}));
vi.mock("@/modules/workspace-process", () => ({
  currentWorkspaceBootstrap: () => ({ environmentKey: "local" }),
}));
vi.mock("@/modules/ai/lib/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/ai/lib/sessions")>()),
  searchSessionContents: sessionSearch,
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
import { MAIN_AGENT } from "@/modules/ai/lib/agents";
import type { SessionMeta } from "@/modules/ai/lib/sessions";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { useChatStore } from "../store/chatStore";
import { AiSidebarPanel } from "./AiSidebarPanel";

const sessionId = "11111111-1111-4111-8111-111111111111";
const transport = {
  sendMessages: async () => new ReadableStream(),
  reconnectToStream: async () => null,
};
const reviewAgent = {
  ...MAIN_AGENT,
  id: "a-review",
  name: "Reviewer",
  icon: "reviewer" as const,
};

function session(
  id: string,
  title: string,
  agent = MAIN_AGENT,
  updatedAt = 1,
): SessionMeta {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt,
    environmentKey: "local",
    cwd: "D:/workspace",
    agentId: agent.id,
    agentName: agent.name,
    agentIcon: agent.icon,
  };
}

function message(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function chat(messages: UIMessage[]): Chat<UIMessage> {
  return new Chat({ id: sessionId, messages, transport });
}

afterEach(() => {
  runtime.chat = null;
  sessionSearch.mockReset();
  useCommandStore.setState({ sessions: {} });
  useAgentsStore.setState({ agents: [] });
  useChatStore.setState({ sessionAgentFilter: null });
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

describe("AI session picker", () => {
  it("filters sessions by a case-insensitive title substring", async () => {
    await preloadEn();
    const mainSession = session(sessionId, "Main conversation", MAIN_AGENT, 1);
    const reviewSession = session(
      "44444444-4444-4444-8444-444444444444",
      "Review conversation",
      reviewAgent,
      2,
    );
    useAgentsStore.setState({ agents: [MAIN_AGENT, reviewAgent] });
    useChatStore.setState({
      activeSessionId: mainSession.id,
      sessions: [mainSession, reviewSession],
      runLockSessionIds: {},
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<AiSidebarPanel hasComposer visible />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Switch session"]')
        ?.click(),
    );
    const popover = document.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    );
    const input = popover?.querySelector<HTMLInputElement>(
      'input[placeholder="Search sessions…"]',
    );
    expect(document.activeElement).not.toBe(input);
    await act(async () => input?.focus());
    expect(document.activeElement).toBe(input);
    await act(async () => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "REVIEW");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(popover?.textContent).toContain("Review conversation");
    expect(popover?.textContent).not.toContain("Main conversation");
    expect(sessionSearch).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("searches conversation content and shows the matching preview", async () => {
    await preloadEn();
    const mainSession = session(sessionId, "First session", MAIN_AGENT, 1);
    const reviewSession = session(
      "55555555-5555-4555-8555-555555555555",
      "Second session",
      reviewAgent,
      2,
    );
    sessionSearch.mockResolvedValueOnce([
      { id: reviewSession.id, preview: "Matched text from the conversation" },
    ]);
    useAgentsStore.setState({ agents: [MAIN_AGENT, reviewAgent] });
    useChatStore.setState({
      activeSessionId: mainSession.id,
      sessions: [mainSession, reviewSession],
      runLockSessionIds: {},
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<AiSidebarPanel hasComposer visible />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Switch session"]')
        ?.click(),
    );
    const popover = document.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    );
    await act(async () =>
      popover
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Filter by agent"]',
        )
        ?.click(),
    );
    const reviewFilter = Array.from(
      popover?.querySelectorAll<HTMLLabelElement>("label") ?? [],
    ).find((label) => label.textContent?.includes("Reviewer"));
    await act(async () => reviewFilter?.click());
    await act(async () =>
      popover
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Also search conversation content"]',
        )
        ?.click(),
    );
    const input = popover?.querySelector<HTMLInputElement>(
      'input[placeholder="Search sessions…"]',
    );
    await act(async () => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "matched text");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    });

    expect(sessionSearch).toHaveBeenCalledWith("matched text", [
      reviewSession.id,
    ]);
    expect(popover?.textContent).toContain("Second session");
    expect(popover?.textContent).toContain(
      "Matched text from the conversation",
    );
    expect(popover?.textContent).not.toContain("First session");

    await act(async () => {
      useChatStore.setState({
        sessions: useChatStore.getState().sessions.map((item) => ({ ...item })),
      });
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    });
    expect(sessionSearch).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("keeps the popover and inline agent filter open after filtering", async () => {
    await preloadEn();
    const mainSession = session(sessionId, "Main conversation", MAIN_AGENT, 1);
    const reviewSession = session(
      "22222222-2222-4222-8222-222222222222",
      "Review conversation",
      reviewAgent,
      2,
    );
    useAgentsStore.setState({ agents: [MAIN_AGENT, reviewAgent] });
    useChatStore.setState({
      activeSessionId: mainSession.id,
      sessions: [mainSession, reviewSession],
      runLockSessionIds: {},
      sessionAgentFilter: null,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<AiSidebarPanel hasComposer visible />));
    const picker = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Switch session"]',
    );
    await act(async () => picker?.click());
    const popover = document.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    );
    expect(popover).not.toBeNull();

    const filter = Array.from(
      popover?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.getAttribute("aria-label") === "Filter by agent");
    await act(async () => filter?.click());
    const reviewOption = Array.from(
      popover?.querySelectorAll<HTMLLabelElement>("label") ?? [],
    ).find((label) => label.textContent?.includes("Reviewer"));
    await act(async () => reviewOption?.click());

    expect(useChatStore.getState().sessionAgentFilter).toBe(reviewAgent.id);
    expect(document.querySelector('[data-slot="popover-content"]')).toBe(
      popover,
    );
    expect(
      popover
        ?.querySelector('[data-slot="collapsible-content"]')
        ?.getAttribute("data-state"),
    ).toBe("open");
    expect(popover?.textContent).toContain("Review conversation");
    expect(popover?.textContent).not.toContain("Main conversation");

    await act(async () => root.unmount());
  });

  it("closes the popover after selecting a session", async () => {
    await preloadEn();
    const mainSession = session(sessionId, "Main conversation", MAIN_AGENT, 1);
    const reviewSession = session(
      "33333333-3333-4333-8333-333333333333",
      "Review conversation",
      reviewAgent,
      2,
    );
    useAgentsStore.setState({ agents: [MAIN_AGENT, reviewAgent] });
    useChatStore.setState({
      activeSessionId: mainSession.id,
      sessions: [mainSession, reviewSession],
      runLockSessionIds: {},
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<AiSidebarPanel hasComposer visible />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Switch session"]')
        ?.click(),
    );
    const openPopover = document.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    );
    await act(async () =>
      openPopover
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Also search conversation content"]',
        )
        ?.click(),
    );
    const openInput = openPopover?.querySelector<HTMLInputElement>(
      'input[placeholder="Search sessions…"]',
    );
    await act(async () => {
      if (!openInput) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(openInput, "main");
      openInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const sessionButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-slot="popover-content"] button',
      ),
    ).find((button) => button.textContent?.includes("Main conversation"));
    await act(async () => sessionButton?.click());

    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Switch session"]')
        ?.click(),
    );
    const reopened = document.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    );
    expect(
      reopened?.querySelector<HTMLInputElement>(
        'input[placeholder="Search sessions…"]',
      )?.value,
    ).toBe("");
    expect(
      reopened
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Also search conversation content"]',
        )
        ?.getAttribute("aria-pressed"),
    ).toBe("false");

    await act(async () => root.unmount());
  });
});
