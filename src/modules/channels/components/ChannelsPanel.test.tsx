// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Chat, UIMessage } from "@ai-sdk/react";
import { ChannelsPanel } from "@/modules/channels/components/ChannelsPanel";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useChannelsView } from "@/modules/channels/client";

const io = vi.hoisted(() => ({
  chats: new Map<string, Chat<UIMessage>>(),
  load: vi.fn(),
  release: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/modules/ai/store/chatRuntime", () => ({ loadChat: io.load }));
vi.mock("@/modules/ai/store/chatStore", async () => {
  const { create } = await import("zustand");
  return {
    chats: io.chats,
    releaseUnusedChats: vi.fn(),
    retainSessionView: () => io.release,
    useChatStore: create(() => ({ sessions: [{ id: "a" }, { id: "b" }] })),
  };
});
vi.mock("@/modules/channels/components/ChannelConversation", () => ({
  ChannelConversation: ({ chat }: { chat: Chat<UIMessage> }) => (
    <p data-chat>{chat.id}</p>
  ),
}));

it("空面板可打开；切换、隐藏和外部失效不保留旧会话，读取失败明确提示", async () => {
  const pending = new Map<string, (chat: Chat<UIMessage>) => void>();
  io.load.mockImplementation(
    (id: string) =>
      new Promise<Chat<UIMessage>>((resolve) => {
        pending.set(id, (chat) => {
          io.chats.set(id, chat);
          resolve(chat);
        });
      }),
  );
  const select = (id: string) =>
    useChannelsView.setState({
      snapshots: [
        {
          connection: {
            id: "connection",
            kind: "weixin",
            name: "WeChat",
            accountId: "owner",
            enabled: true,
            busyMessageMode: "queue",
          },
          status: "online",
          issue: null,
          busy: false,
          queued: 0,
          conversations: [
            {
              sessionId: id,
              target: { kind: "direct", id: "owner" },
              busy: false,
              queued: 0,
            },
          ],
        },
      ],
    });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    useChannelsView.setState({ snapshots: [] });
    await act(async () => root.render(<ChannelsPanel visible />));
    expect(container.textContent).toContain("outbound.noTarget");
    await act(async () => select("a"));
    await act(async () => select("b"));
    await act(async () => pending.get("a")?.({ id: "a" } as Chat<UIMessage>));
    expect(container.querySelector("[data-chat]")).toBeNull();
    await act(async () => pending.get("b")?.({ id: "b" } as Chat<UIMessage>));
    expect(container.querySelector("[data-chat]")?.textContent).toBe("b");
    await act(async () => {
      io.chats.delete("b");
      io.load.mockRejectedValue(new Error("read failed"));
      useChatStore.setState({ sessions: [{ id: "b" }] as never });
    });
    expect(container.querySelector("[data-chat]")).toBeNull();
    expect(container.textContent).toContain("errors.storage");
    await act(async () => root.render(<ChannelsPanel visible={false} />));
    expect(container.querySelector("[data-chat]")).toBeNull();
    expect(io.release).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});
