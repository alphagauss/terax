import { channelOwnerId, channelSessionId } from "@/modules/channels/identity";
/**
 * 本文件验证 Channel 回复投影与会话终态保存的失败边界。
 * 只投递最后一步的公开正文，保存失败必须结束等待而不发送未落盘的回复。
 */

import {
  startChatMessage,
  steerChatMessage,
} from "@/modules/ai/store/chatRuntime";
import { chats, useChatStore } from "@/modules/ai/store/chatStore";
import {
  channelReplyText,
  ensureChannelSession,
  runChannelTurn,
} from "@/modules/channels/agentSession";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { modelRefKey } from "@/modules/ai/config";
import {
  readModelUsages,
  channelModelUsageId,
} from "@/modules/ai/lib/modelUsage";
import type { ModelParameter } from "@/modules/ai/lib/modelParameters";
import type { UIMessage } from "ai";
import { beforeEach, expect, it, vi } from "vitest";
import { commitSession } from "@/modules/ai/lib/sessions";
vi.mock("@/modules/ai/lib/sessions", async (importOriginal) => ({
  ...(await importOriginal()),
  commitSession: vi.fn(),
}));
vi.mock("@/modules/channels/workspace", () => ({
  prepareChannelWorkspace: async () => "D:/workspace",
}));

vi.mock("@/lib/platform", () => ({ HOST_PLATFORM: "windows" }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/modules/ai/store/chatRuntime", () => ({
  loadChat: async (id: string) => chats.get(id),
  startChatMessage: vi.fn(),
  steerChatMessage: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(startChatMessage).mockReset();
  vi.mocked(steerChatMessage).mockReset();
  usePreferencesStore.setState({
    modelUsages: readModelUsages({}),
    modelParameters: {},
    providerModels: {
      "builtin:deepseek": [
        { id: "deepseek-chat", source: "manual", contextWindow: 128000 },
      ],
    },
  });
});

it.each([false, true])(
  "模型错误保留具体原因，取消=%s 时不发送失败通知",
  async (cancelled) => {
    const connection = {
      id: "channel",
      sessionId: "failed-session",
      target: { kind: "direct" as const, id: "owner" },
      kind: "weixin" as const,
      name: "WeChat",
      enabled: true,
      accountId: "owner",
      busyMessageMode: "queue" as const,
    };
    const chat = { status: "ready", messages: [] as UIMessage[] };
    chats.set(connection.sessionId, chat as never);
    usePreferencesStore.setState({
      defaultModel: {
        providerId: "builtin:deepseek",
        modelId: "deepseek-chat",
      },
    });
    useChatStore.setState({
      sessions: [
        {
          id: connection.sessionId,
          channelId: await channelOwnerId(connection),
          environmentKey: "local",
          cwd: "D:/workspace",
        } as never,
      ],
      agentMetaBySession: {},
      runLockSessionIds: {},
    });
    vi.mocked(startChatMessage).mockImplementation(async () => {
      useChatStore.getState().patchAgentMeta(connection.sessionId, {
        status: "error",
        error: "connection reset",
        cancelled,
      });
      return true;
    });
    try {
      const result = runChannelTurn(
        connection,
        {
          id: "input",
          senderId: "owner",
          text: "hello",
          receivedAt: 1,
          attachments: [],
          target: connection.target,
        },
        new AbortController().signal,
        () => {},
      );
      if (cancelled) await expect(result).resolves.toBeNull();
      else
        await expect(result).rejects.toMatchObject({
          issue: "agent",
          detail: "connection reset",
        });
    } finally {
      chats.clear();
    }
  },
);

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
    target: { kind: "direct" as const, id: "owner" },
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
        channelId: await channelOwnerId(connection),
        environmentKey: "local",
        cwd: "D:/workspace",
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
      attachments: [],
      target: { kind: "direct" as const, id: "owner" },
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

it("reads the new Chat response after retrying a previous terminal commit", async () => {
  const connection = {
    id: "retry-channel",
    sessionId: "retry-session",
    target: { kind: "direct" as const, id: "owner" },
    kind: "weixin" as const,
    name: "Retry",
    enabled: true,
    accountId: "owner",
    busyMessageMode: "queue" as const,
  };
  const previous = { status: "ready", messages: [] as UIMessage[] };
  const next = { status: "ready", messages: [] as UIMessage[] };
  useChatStore.setState({
    sessions: [
      {
        id: connection.sessionId,
        channelId: await channelOwnerId(connection),
        environmentKey: "local",
        cwd: "D:/workspace",
      } as never,
    ],
    agentMetaBySession: {},
    runLockSessionIds: { [connection.sessionId]: true },
  });
  usePreferencesStore.setState({
    defaultModel: { providerId: "builtin:deepseek", modelId: "deepseek-chat" },
  });
  chats.set(connection.sessionId, previous as never);
  useChatStore.getState().patchAgentMeta(connection.sessionId, {
    commitError: "previous save failed",
  });
  const commit = vi
    .spyOn(useChatStore.getState(), "commitMessages")
    .mockImplementation(async () => {
      chats.set(connection.sessionId, next as never);
      useChatStore
        .getState()
        .patchAgentMeta(connection.sessionId, { commitError: undefined });
    });
  vi.mocked(startChatMessage).mockImplementation(async () => {
    next.messages = [
      {
        id: "reply",
        role: "assistant",
        parts: [{ type: "text", text: "new response" }],
      },
    ];
    useChatStore.setState({ runLockSessionIds: {} });
    return true;
  });
  try {
    await expect(
      runChannelTurn(
        connection,
        {
          id: "input",
          senderId: "owner",
          text: "hello",
          receivedAt: 1,
          attachments: [],
          target: { kind: "direct" as const, id: "owner" },
        },
        new AbortController().signal,
        () => {},
      ),
    ).resolves.toBe("new response");
  } finally {
    commit.mockRestore();
    chats.clear();
  }
});

it("重建同账号实例可以恢复原会话，其他账号不能取得归属", async () => {
  const account = { kind: "weixin" as const, accountId: "owner" };
  const target = { kind: "direct" as const, id: "peer" };
  const sessionId = await channelSessionId(account, target);
  const connection = {
    ...account,
    id: "replacement",
    name: "New instance",
    enabled: true,
    busyMessageMode: "queue" as const,
    sessionId,
    target,
  };
  useChatStore.setState({
    sessions: [
      {
        id: sessionId,
        agentId: "builtin:channel",
        agentName: "Channel",
        agentIcon: "spark",
        channelId: await channelOwnerId(account),
        cwd: "D:/workspace",
        environmentKey: "local",
        createdAt: 1,
        updatedAt: 1,
        title: "peer",
      },
    ],
  });
  vi.mocked(commitSession).mockClear();
  await ensureChannelSession(connection);
  expect(commitSession).not.toHaveBeenCalled();
  await expect(
    ensureChannelSession({ ...connection, accountId: "another" }),
  ).rejects.toMatchObject({ issue: "storage" });
});

it("并发入口只创建一次 Channel 会话，不持久化可变提示词与工具", async () => {
  useChatStore.setState({ sessions: [] });
  let release!: () => void;
  vi.mocked(commitSession)
    .mockReset()
    .mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        id: "channel-session",
        channelId: await channelOwnerId({ kind: "weixin", accountId: "owner" }),
        environmentKey: "local",
        cwd: "D:/workspace",
      } as never;
    });
  const creating = Promise.all(
    [0, 1].map(() =>
      ensureChannelSession({
        id: "connection",
        sessionId: "channel-session",
        target: { kind: "direct" as const, id: "owner" },
        kind: "weixin",
        name: "WeChat",
        enabled: true,
        accountId: "owner",
        busyMessageMode: "queue",
      }),
    ),
  );
  await vi.waitFor(() => expect(release).toBeDefined());
  release();
  await creating;
  expect(commitSession).toHaveBeenCalledTimes(1);
  expect(commitSession).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: "D:/workspace",
      metadata: {
        title: "owner",
        channelId: await channelOwnerId({ kind: "weixin", accountId: "owner" }),
        agent: { id: "builtin:channel", name: "Channel", icon: "spark" },
      },
    }),
  );
});

it("freezes each Channel task independently while steering keeps the current snapshot", async () => {
  const connection = {
    id: "a",
    sessionId: "session-a",
    target: { kind: "direct" as const, id: "owner" },
    kind: "weixin" as const,
    name: "A",
    enabled: true,
    accountId: "owner",
    busyMessageMode: "steer" as const,
  };
  const model = { providerId: "builtin:deepseek", modelId: "deepseek-chat" };
  const other = { ...model, modelId: "other" };
  const parameter: ModelParameter = {
    id: "temperature",
    label: "Temperature",
    target: "standard",
    path: "temperature",
    valueType: "number",
    options: [
      { id: "low", label: "Low", value: 0.1 },
      { id: "high", label: "High", value: 0.9 },
    ],
    defaultOption: "low",
    showInSummary: true,
  };
  const usages = readModelUsages({});
  usages[channelModelUsageId("a")] = {
    model: null,
    parameterSelections: { [modelRefKey(model)]: { temperature: "high" } },
  };
  usages[channelModelUsageId("b")] = { model: other, parameterSelections: {} };
  usePreferencesStore.setState({
    defaultModel: model,
    modelUsages: usages,
    modelParameters: {
      [modelRefKey(model)]: [parameter],
      [modelRefKey(other)]: [parameter],
    },
    providerModels: {
      [model.providerId]: [model, other].map((ref) => ({
        id: ref.modelId,
        source: "manual",
        contextWindow: 128000,
      })),
    },
  });
  const chat = { status: "ready", messages: [] as UIMessage[] };
  chats.set(connection.sessionId, chat as never);
  useChatStore.setState({
    sessions: [
      {
        id: connection.sessionId,
        channelId: await channelOwnerId(connection),
        environmentKey: "local",
        cwd: "D:/workspace",
      } as never,
    ],
    agentMetaBySession: {},
    runLockSessionIds: {},
  });
  const input = {
    id: "input",
    senderId: "owner",
    text: "hello",
    receivedAt: 1,
    attachments: [],
    target: { kind: "direct" as const, id: "owner" },
  };
  vi.mocked(startChatMessage).mockImplementation(async () => {
    chat.messages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: "done" }],
    });
    return true;
  });
  const task = runChannelTurn(
    connection,
    input,
    new AbortController().signal,
    (steer) => {
      expect(
        steer({
          ...input,
          id: "command",
          text: "/init",
          target: { kind: "group", id: "room" },
        }),
      ).toBeNull();
      steer({ ...input, id: "guide" });
    },
  );
  // 在异步会话准备期间修改全局默认和该连接配置，不得改变已发起任务。
  usePreferencesStore.setState({
    defaultModel: other,
    modelUsages: {
      ...usages,
      [channelModelUsageId("a")]: { model: other, parameterSelections: {} },
    },
  });
  await expect(task).resolves.toBe("done");
  expect(startChatMessage).toHaveBeenCalledTimes(1);
  const first = vi.mocked(startChatMessage).mock.calls[0][2];
  expect(first).toEqual({
    id: await channelOwnerId(connection),
    model,
    parameters: [{ target: "standard", path: "temperature", value: 0.9 }],
  });
  expect(steerChatMessage).toHaveBeenCalledWith(
    connection.sessionId,
    expect.objectContaining({ role: "user" }),
    await channelOwnerId(connection),
  );
  await runChannelTurn(
    connection,
    input,
    new AbortController().signal,
    () => {},
  );
  expect(vi.mocked(startChatMessage).mock.calls[1][2]).toEqual({
    id: await channelOwnerId(connection),
    model: other,
    parameters: [{ target: "standard", path: "temperature", value: 0.1 }],
  });
  expect(first?.model).toEqual(model);
  chats.clear();
});

it("does not replace an explicitly unavailable Channel model with the global default", async () => {
  const model = { providerId: "builtin:deepseek", modelId: "removed" };
  usePreferencesStore.setState({
    modelUsages: {
      ...readModelUsages({}),
      "channel:a": { model, parameterSelections: {} },
    },
  });
  await expect(
    runChannelTurn(
      { id: "a" } as never,
      { text: "hello" } as never,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toMatchObject({ issue: "model" });
  expect(startChatMessage).not.toHaveBeenCalled();
});
