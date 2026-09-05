/**
 * 本文件验证 Channel 回复投影与会话终态保存的失败边界。
 * 只投递最后一步的公开正文，保存失败必须结束等待而不发送未落盘的回复。
 */

import { startChatMessage } from "@/modules/ai/store/chatRuntime";
import { chats, useChatStore } from "@/modules/ai/store/chatStore";
import {
  channelReplyText,
  runChannelTurn,
} from "@/modules/channels/agentSession";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { UIMessage } from "ai";
import { expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ HOST_PLATFORM: "windows" }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/modules/ai/store/chatRuntime", () => ({
  getOrCreateChat: (id: string) => chats.get(id),
  startChatMessage: vi.fn(),
}));

it("delivers only the final assistant step even when hidden events follow", () => {
  const messages: UIMessage[] = [
    {
      id: "answer",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "Checking files" },
        { type: "step-start" },
        { type: "reasoning", text: "Private reasoning" },
        { type: "text", text: "Completed the requested change." },
      ],
    },
    {
      id: "internal",
      role: "user",
      parts: [
        { type: "data-subagent-result", data: { text: "Internal result" } },
      ],
    },
  ];
  expect(channelReplyText(messages)).toBe("Completed the requested change.");
});

it("ends the Channel wait on a terminal save failure without sending an unpersisted reply", async () => {
  const connection = {
    id: "channel",
    sessionId: "session",
    kind: "weixin" as const,
    name: "WeChat",
    enabled: true,
    accountId: "owner",
    busyMessageMode: "queue" as const,
  };
  const chat = { status: "ready", messages: [] };
  chats.set(connection.sessionId, chat as never);
  usePreferencesStore.setState({
    defaultModel: { providerId: "builtin:deepseek", modelId: "deepseek-chat" },
  });
  useChatStore.setState({
    sessions: [
      {
        id: connection.sessionId,
        channelId: connection.id,
        environmentKey: "local",
      } as never,
    ],
    agentMetaBySession: {},
    runLockSessionIds: { [connection.sessionId]: true },
  });
  vi.mocked(startChatMessage).mockResolvedValue(true);
  const turn = runChannelTurn(
    connection,
    {
      id: "input",
      senderId: "owner",
      text: "hello",
      receivedAt: 1,
      replyContext: "context",
    },
    new AbortController().signal,
    () => {},
  );
  const failed = expect(turn).rejects.toMatchObject({ issue: "storage" });
  await vi.waitFor(() => expect(startChatMessage).toHaveBeenCalled());
  useChatStore
    .getState()
    .patchAgentMeta(connection.sessionId, { commitError: "disk full" });
  await failed;
  expect(useChatStore.getState().runLockSessionIds[connection.sessionId]).toBe(
    true,
  );
  chats.clear();
});
