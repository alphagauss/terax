/**
 * 本文件验证 AI 会话的窗口级恢复、多进程同步、运行锁和两阶段发布。
 * 测试锁定临时窗口与失效选择回退草稿，以及运行和持久化的关键顺序。
 */

import {
  clearAgentTurnCoordinator,
  getAgentTurnCoordinator,
} from "@/modules/ai/agents/subagentRuntime";
import { modelRefKey } from "@/modules/ai/config";
import {
  conversationEventPart,
  convertToAgentModelMessages,
  projectSessionMessages,
  type SessionMessage,
  type TurnEvent,
} from "@/modules/ai/lib/conversation";
import {
  canReviseHistory,
  editLastMessage,
  forkSession,
  loadChat,
  sendChatMessage,
  startChatMessage,
  steerChatMessage,
} from "@/modules/ai/store/chatRuntime";
import { appendSessionDisplay, clearIdleSessionProcesses } from "@/modules/ai/store/chatStore";
import {
  projectDeliveries,
  useDeliveryHistory,
} from "@/modules/channels/history";
import type { UIMessage } from "ai";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  revise: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  list: vi.fn(),
  commit: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
  clearProcesses: vi.fn(),
  workspaceGet: vi.fn(),
  workspaceSet: vi.fn(),
  workspaceDelete: vi.fn(),
  isPrimary: true,
  sharedRead: vi.fn(),
  sharedMutate: vi.fn(),
}));

vi.mock("@/lib/sharedStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sharedStore")>()),
  readSharedStore: io.sharedRead,
  mutateSharedStore: io.sharedMutate,
}));

vi.mock("@/modules/ai/lib/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/ai/lib/sessions")>()),
  reviseSessionHistory: io.revise,
  acquireSessionRun: io.acquire,
  releaseSessionRun: io.release,
  listSessions: io.list,
  commitSession: io.commit,
  readSession: io.read,
  deleteSessionFile: io.remove,
  clearSessionProcesses: io.clearProcesses,
}));

vi.mock("@/modules/workspace-process", () => ({
  currentWorkspaceBootstrap: () => ({
    environmentKey: "local",
    isPrimary: io.isPrimary,
    env: { kind: "local" },
  }),
  getWorkspaceValue: io.workspaceGet,
  setWorkspaceValue: io.workspaceSet,
  deleteWorkspaceValue: io.workspaceDelete,
}));

vi.mock("@/modules/ai/lib/modelPrefs", () => ({ pushRecentModel: vi.fn() }));

import { parseCommand } from "@/modules/ai/commands/registry";
import { submitSessionCommand } from "@/modules/ai/commands/runtime";
import {
  useCommandStore,
  cancelSessionCommand,
} from "@/modules/ai/commands/store";
import { MAIN_AGENT_ID } from "@/modules/ai/lib/agents";
import type { SessionFile, SessionMeta } from "@/modules/ai/lib/sessions";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import {
  chats,
  flushCompletedSessionRuns,
  getSessionParameterSelections,
  isSessionWritable,
  pendingTurns,
  persistedMessageCounts,
  releaseUnusedChats,
  retainSessionView,
  seedMessages,
  seedSession,
  sessionMetadata,
  stopSession,
  useChatStore,
} from "@/modules/ai/store/chatStore";
import { useSessionAttentionStore } from "@/modules/ai/store/sessionAttentionStore";
import { usePreferencesStore } from "@/modules/settings/preferences";

const realRefreshSessions = useChatStore.getState().refreshSessions;
const realCommitMessages = useChatStore.getState().commitMessages;
const realPersistSubmittedTurn = useChatStore.getState().persistSubmittedTurn;
const realPersistTurnCheckpoint = useChatStore.getState().persistTurnCheckpoint;

const first: SessionMeta = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "First",
  createdAt: 1,
  updatedAt: 2,
  environmentKey: "local",
  cwd: "D:/workspace/first",
  agentId: "builtin:main",
  agentName: "Terax",
  agentIcon: "coder",
  fingerprint: "disk:1",
};
const second: SessionMeta = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Second",
  createdAt: 1,
  updatedAt: 1,
  environmentKey: "local",
  cwd: "D:/workspace/second",
  agentId: "builtin:main",
  agentName: "Terax",
  agentIcon: "coder",
  fingerprint: "disk:2",
};
const third: SessionMeta = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Third",
  createdAt: 1,
  updatedAt: 0,
  environmentKey: "local",
  cwd: "D:/workspace/third",
  agentId: "builtin:main",
  agentName: "Terax",
  agentIcon: "coder",
  fingerprint: "disk:3",
};

const sessionFile = (meta: SessionMeta) => ({
  id: meta.id,
  createdAt: meta.createdAt,
  updatedAt: meta.updatedAt,
  environmentKey: meta.environmentKey,
  cwd: meta.cwd,
  metadata: {
    title: meta.title,
    agent: {
      id: meta.agentId,
      name: meta.agentName,
      icon: meta.agentIcon,
      instructions: "",
      tools: ["read_file"],
    },
  },
  messages: [],
});

describe("chat store multi-process lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chats.clear();
    seedMessages.clear();
    persistedMessageCounts.clear();
    sessionMetadata.clear();
    pendingTurns.clear();
    useCommandStore.setState({ sessions: {} });
    useAgentsStore.setState({
      agents: [],
      draftAgentId: MAIN_AGENT_ID,
    });
    useSessionAttentionStore.setState({
      bySession: {},
      revealLatestBySession: {},
      pendingCompletions: [],
    });
    io.sharedRead.mockResolvedValue({});
    io.sharedMutate.mockResolvedValue(undefined);
    io.acquire.mockResolvedValue(true);
    io.release.mockResolvedValue(undefined);
    io.list.mockResolvedValue([]);
    io.commit.mockImplementation(
      async (session: {
        id: string;
        cwd: string;
        metadata: {
          title: string;
          agent?: { id: string; name: string; icon: "coder" };
        };
        updatedAt: number;
      }) => ({
        id: session.id,
        title: session.metadata.title,
        createdAt: 1,
        updatedAt: session.updatedAt,
        environmentKey: "local",
        cwd: session.cwd,
        agentId: session.metadata.agent?.id ?? "builtin:main",
        agentName: session.metadata.agent?.name ?? "Terax",
        agentIcon: session.metadata.agent?.icon ?? "coder",
        modifiedAt: 10,
        size: 20,
        fingerprint: "disk:committed",
      }),
    );
    io.read.mockImplementation(async (id: string) =>
      sessionFile(id === first.id ? first : second),
    );
    io.remove.mockResolvedValue(undefined);
    io.clearProcesses.mockResolvedValue(undefined);
    io.workspaceGet.mockReturnValue(undefined);
    io.workspaceSet.mockResolvedValue(undefined);
    io.workspaceDelete.mockResolvedValue(undefined);
    io.isPrimary = true;
    useChatStore.setState({
      editingMessage: null,
      sessionsHydrated: false,
      draftSessionId: null,
      sessions: [],
      activeSessionId: null,
      activeSessionRevision: 0,
      chatViewVisible: true,
      runLockSessionIds: {},
      agentMetaBySession: {},
      subagentDisplaysBySession: {},
      sessionAgentFilter: null,
      sessionSyncError: null,
      selectedModel: null,
      parameterSelectionsBySession: {},
      modelSnapshotsBySession: {},
      pendingSelections: [],
      pendingFileAttachments: [],
      refreshSessions: realRefreshSessions,
      commitMessages: realCommitMessages,
      persistSubmittedTurn: realPersistSubmittedTurn,
      persistTurnCheckpoint: realPersistTurnCheckpoint,
    });
  });

  it("holds the session lock throughout explicit process cleanup and releases it on failure", async () => {
    useChatStore.setState({ sessions: [first], activeSessionId: first.id });
    let finish!: () => void;
    io.clearProcesses.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const cleanup = clearIdleSessionProcesses(first.id);
    await vi.waitFor(() => expect(io.clearProcesses).toHaveBeenCalledWith(first.id));
    expect(await useChatStore.getState().beginSessionRun(first.id)).toBe(false);
    finish();
    await cleanup;
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
    io.clearProcesses.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(clearIdleSessionProcesses(first.id)).rejects.toThrow("cleanup failed");
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
    expect(io.release).toHaveBeenCalledTimes(2);
  });

  it("编辑失败保留原历史和编辑内容，运行及保存期间拒绝历史操作", async () => {
    useChatStore.setState({
      sessions: [first],
      activeSessionId: first.id,
      selectedModel: { providerId: "builtin:ollama", modelId: "test" },
      editingMessage: { sessionId: first.id, messageId: "user" },
    });
    const chat = await loadChat(first.id);
    const before = chat.messages;
    const sending = vi.spyOn(chat, "sendMessage");
    expect(await startChatMessage(first.id, { text: "competing send" })).toBe(
      false,
    );
    io.revise.mockRejectedValue(new Error("disk failure"));
    expect(canReviseHistory(first.id)).toBe(true);
    await expect(editLastMessage(first.id, "user", "changed")).rejects.toThrow(
      "disk failure",
    );
    expect(chat.messages).toBe(before);
    expect(sending).not.toHaveBeenCalled();
    expect(useChatStore.getState().editingMessage?.messageId).toBe("user");
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
    useChatStore.setState({ runLockSessionIds: { [first.id]: true } });
    expect(canReviseHistory(first.id)).toBe(false);
    expect(await editLastMessage(first.id, "user", "changed")).toBe(false);
    await forkSession(first.id, "turn");
    expect(io.revise).toHaveBeenCalledTimes(1);
  });

  it("编辑成功先安装已落盘历史和游标，再续发且不重复追加用户消息", async () => {
    useChatStore.setState({
      sessions: [first],
      activeSessionId: first.id,
      selectedModel: { providerId: "builtin:ollama", modelId: "test" },
    });
    const chat = await loadChat(first.id);
    useDeliveryHistory.setState({
      sessions: { [first.id]: [{ id: "discarded" } as never] },
    });
    const saved: SessionFile = sessionFile(first);
    saved.messages = [
      {
        role: "user",
        message_id: "edited",
        content: "changed",
        timestamp: new Date().toISOString(),
      },
    ];
    io.revise.mockResolvedValue({
      meta: { ...first, fingerprint: "edited" },
      session: saved,
    });
    const sending = vi
      .spyOn(chat, "sendMessage")
      .mockImplementation(async (message) => {
        expect(message).toBeUndefined();
        expect(
          useDeliveryHistory.getState().sessions[first.id],
        ).toBeUndefined();
        expect(chat.messages[0].id).toBe("edited");
        expect(persistedMessageCounts.get(first.id)).toBe(chat.messages.length);
        expect(useChatStore.getState().sessions[0].fingerprint).toBe("edited");
      });
    expect(await editLastMessage(first.id, "edited", "changed")).toBe(true);
    expect(sending).toHaveBeenCalledOnce();
    useChatStore.setState({ runLockSessionIds: {} });
    sending.mockRestore();
  });

  it("分叉直接使用已提交记录和参数，不重复读盘或调用模型", async () => {
    useChatStore.setState({ sessions: [first], activeSessionId: first.id });
    const source = await loadChat(first.id);
    const sending = vi.spyOn(source, "sendMessage");
    const selections = { "builtin:ollama/test": { temperature: "low" } };
    useChatStore.setState({
      parameterSelectionsBySession: { [first.id]: selections },
    });
    const saved: SessionFile = {
      ...sessionFile(second),
      messages: [
        {
          role: "user",
          message_id: "original-user",
          content: "original",
          timestamp: new Date().toISOString(),
        },
      ],
    };
    io.revise.mockResolvedValue({ meta: second, session: saved });
    io.list.mockResolvedValue([first, second]);
    io.read.mockClear();
    await forkSession(first.id, "turn");
    expect(useChatStore.getState().activeSessionId).toBe(second.id);
    expect(getSessionParameterSelections(second.id)).toEqual(selections);
    expect(io.workspaceSet).toHaveBeenCalledWith(
      `ai:parameters:${second.id}`,
      selections,
    );
    const fork = await loadChat(second.id);
    expect(fork.messages[0].id).toBe("original-user");
    expect(io.read).not.toHaveBeenCalled();
    expect(sending).not.toHaveBeenCalled();
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
  });

  it("切换或刷新会话取消原位编辑，其他状态更新保留编辑", () => {
    const editingMessage = { sessionId: first.id, messageId: "user" };
    useChatStore.setState({
      sessions: [first, second],
      activeSessionId: first.id,
      editingMessage,
    });
    useChatStore.getState().patchAgentMeta(first.id, { status: "idle" });
    expect(useChatStore.getState().editingMessage).toBe(editingMessage);
    useChatStore.setState({ activeSessionRevision: 1 });
    expect(useChatStore.getState().editingMessage).toBeNull();
    useChatStore.setState({ editingMessage });
    useChatStore.getState().newSession();
    expect(useChatStore.getState().editingMessage).toBeNull();
  });

  it("其他工作环境及 Channel 的历史操作保持只读", async () => {
    for (const session of [
      { ...first, environmentKey: "wsl:Ubuntu" },
      { ...first, channelId: "channel" },
    ]) {
      useChatStore.setState({ sessions: [session], activeSessionId: first.id });
      expect(canReviseHistory(first.id)).toBe(false);
      expect(await editLastMessage(first.id, "user", "changed")).toBe(false);
      await forkSession(first.id, "turn");
    }
    expect(io.acquire).not.toHaveBeenCalled();
    expect(io.revise).not.toHaveBeenCalled();
  });

  it("keeps an editor selection path in the draft attachment", () => {
    useChatStore.getState().attachSelection({
      text: "  selected code  ",
      source: "editor",
      path: "D:/workspace/source.ts",
    });
    expect(useChatStore.getState().consumeSelections()).toEqual([
      {
        id: expect.stringMatching(/^sel-/),
        text: "selected code",
        source: "editor",
        path: "D:/workspace/source.ts",
      },
    ]);
    expect(useChatStore.getState().pendingSelections).toEqual([]);
  });

  function commandRequest(
    text = "/help",
    startTask = vi.fn(async (_message: UIMessage) => false),
  ) {
    const command = parseCommand(text);
    assert(command);
    return {
      sessionId: first.id,
      command,
      source: { kind: "desktop" as const },
      startTask,
    };
  }
  function openCommandSession(running = false) {
    useChatStore.setState({
      sessions: [first],
      activeSessionId: first.id,
      runLockSessionIds: running ? { [first.id]: true } : {},
    });
    sessionMetadata.set(first.id, sessionFile(first).metadata);
    chats.set(first.id, {
      status: running ? "streaming" : "ready",
      messages: [],
    } as never);
  }

  it.each([false, true])(
    "终态保存真实模型错误且解锁重试不重复，用户取消=%s 不记为模型失败",
    async (cancelled) => {
      openCommandSession(true);
      const chat = {
        status: "error",
        messages: [
          {
            id: "input",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ] as UIMessage[],
      };
      chats.set(first.id, chat as never);
      useChatStore.getState().patchAgentMeta(first.id, {
        status: "error",
        error: "connection reset",
        cancelled,
      });
      const records: SessionMessage[] = [];
      io.commit.mockImplementation(async (file) => {
        records.push(...file.messages);
        return first;
      });
      io.release.mockRejectedValueOnce(new Error("unlock failed"));
      await expect(
        useChatStore.getState().commitMessages(first.id, chat.messages),
      ).rejects.toThrow("unlock failed");
      await useChatStore.getState().commitMessages(first.id, chat.messages);
      const failures = records.filter(
        (record) =>
          record.role === "event" && record.content.event === "run_failure",
      );
      expect(failures).toHaveLength(cancelled ? 0 : 1);
      if (!cancelled) {
        expect(failures[0]).toMatchObject({
          content: { error: "connection reset" },
        });
        expect(
          JSON.stringify(await convertToAgentModelMessages(chat.messages)),
        ).toContain("previous model request failed");
      }
    },
  );

  it("投递回执保存失败可补交，恢复历史不生成模型消息", async () => {
    openCommandSession();
    const records: SessionMessage[] = [];
    io.commit.mockImplementation(async (file) => {
      records.push(...file.messages);
      return first;
    });
    const timestamp = new Date().toISOString();
    await appendSessionDisplay(first.id, {
      role: "delivery",
      timestamp,
      content: {
        id: "send",
        phase: "request",
        source: "application",
        target: { kind: "direct", id: "owner" },
        content: {
          text: "notice",
          attachments: [{ path: "/report.pdf", presentation: "file" }],
        },
      },
    });
    io.commit.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      appendSessionDisplay(first.id, {
        role: "delivery",
        timestamp,
        content: {
          id: "send",
          phase: "result",
          result: {
            status: "accepted",
            parts: [{ index: 0, status: "accepted" }],
          },
        },
      }),
    ).rejects.toThrow("disk full");
    await useChatStore.getState().commitMessages(first.id, []);
    expect(records.filter((record) => record.role === "delivery")).toHaveLength(
      2,
    );
    expect(projectDeliveries(records)[0].result?.status).toBe("accepted");
    expect(
      useDeliveryHistory.getState().sessions[first.id]?.[0].result?.status,
    ).toBe("accepted");
    expect(
      await convertToAgentModelMessages(
        projectSessionMessages(first.id, records),
      ),
    ).toEqual([]);
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
  });

  it("草稿重置保留到项目目录变化，切回原项目也继续跟随", () => {
    const live = { ...useChatStore.getState().live, draftCwd: "/project" };
    useChatStore.setState({
      live,
      draftCwdOverride: { sessionId: "draft", cwd: "/default/workspace" },
    });
    useChatStore.getState().setLive({ ...live });
    expect(useChatStore.getState().draftCwdOverride?.cwd).toBe(
      "/default/workspace",
    );
    useChatStore.getState().setLive({ ...live, draftCwd: "/other" });
    expect(useChatStore.getState().draftCwdOverride).toBeNull();
    useChatStore.getState().setLive(live);
    expect(useChatStore.getState().draftCwdOverride).toBeNull();
  });

  it("首次帮助无需模型，创建会话但不创建模型消息", async () => {
    useChatStore.setState({
      draftSessionId: first.id,
      activeSessionId: first.id,
      selectedModel: null,
      draftExternalAgentId: null,
      live: { ...useChatStore.getState().live, draftCwd: first.cwd },
    });
    expect(
      await sendChatMessage(first.id, {
        role: "user",
        parts: [{ type: "text", text: "/h" }],
      }),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(
        useCommandStore.getState().sessions[first.id]?.[0].result?.status,
      ).toBe("success"),
    );
    expect(
      io.commit.mock.calls
        .flatMap(([file]) => file.messages)
        .map((record) => record.role),
    ).toEqual(["command", "command"]);
    expect(chats.get(first.id)?.messages).toEqual([]);
    expect(useChatStore.getState().draftSessionId).toBeNull();
    expect(useChatStore.getState().sessions[0].cwd).toBe(first.cwd);
  });

  it("忙碌时帮助不进入引导，终态等待其在途写入再释放锁", async () => {
    openCommandSession(true);
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    io.commit.mockImplementationOnce(async () => {
      await blocked;
      return first;
    });
    const help = submitSessionCommand(commandRequest());
    await vi.waitFor(() => expect(io.commit).toHaveBeenCalledTimes(1));
    const terminal = useChatStore.getState().commitMessages(first.id, []);
    expect(io.release).not.toHaveBeenCalled();
    expect(chats.get(first.id)?.messages).toEqual([]);
    finish();
    await (await help).completed;
    await terminal;
    expect(persistedMessageCounts.get(first.id)).toBe(0);
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
  });

  it("压缩命令等待空闲，完成回执在摘要任务结束后写入且不产生普通用户输入", async () => {
    openCommandSession(true);
    let finish!: () => void;
    const startCompaction = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = () => resolve(true);
        }),
    );
    const request = commandRequest("/compact");
    const receipt = await submitSessionCommand({ ...request, startCompaction });
    expect(startCompaction).not.toHaveBeenCalled();
    useChatStore.setState({ runLockSessionIds: {} });
    await vi.waitFor(() =>
      expect(startCompaction).toHaveBeenCalledWith(expect.any(AbortSignal)),
    );
    expect(
      useCommandStore.getState().sessions[first.id][0].result,
    ).toBeUndefined();
    finish();
    expect((await receipt.completed).status).toBe("success");
    expect(request.startTask).not.toHaveBeenCalled();
    expect(
      io.commit.mock.calls
        .flatMap(([file]) => file.messages)
        .every((record) => record.role === "command"),
    ).toBe(true);
  });

  it("非法压缩参数立即回复，不等待正在运行的 Agent", async () => {
    openCommandSession(true);
    const startCompaction = vi.fn(async () => true);
    const receipt = await submitSessionCommand({
      ...commandRequest("/compact extra"),
      startCompaction,
    });
    const completed = vi.fn();
    void receipt.completed.then(completed);
    try {
      await vi.waitFor(() =>
        expect(completed).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "error",
            text: "commands.invalidArguments",
          }),
        ),
      );
      expect(startCompaction).not.toHaveBeenCalled();
      expect(useChatStore.getState().runLockSessionIds[first.id]).toBe(true);
    } finally {
      cancelSessionCommand(first.id);
      await receipt.completed;
    }
  });

  it("压缩保存失败后停止命令等待展示，保留未确认结果和运行锁", async () => {
    openCommandSession();
    const receipt = await submitSessionCommand({
      ...commandRequest("/compact"),
      startCompaction: async () => {
        useChatStore.setState({ runLockSessionIds: { [first.id]: true } });
        useChatStore
          .getState()
          .patchAgentMeta(first.id, { commitError: "save failed" });
        throw new Error("save failed");
      },
    });
    await expect(receipt.completed).rejects.toThrow("save failed");
    expect(
      useCommandStore.getState().sessions[first.id][0].pending,
    ).toBeUndefined();
    expect(
      useCommandStore.getState().sessions[first.id][0].result,
    ).toBeUndefined();
    expect(useCommandStore.getState().active[first.id]).toBeUndefined();
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBe(true);
  });

  it.each(["commit", "release"] as const)(
    "初始化回执 %s 失败后只补交，不重跑任务或重复追加",
    async (failure) => {
      openCommandSession();
      const startTask = vi.fn(async (message: UIMessage) => {
        expect(io.commit.mock.calls).toHaveLength(1);
        expect(message.parts).toEqual([
          { type: "text", text: expect.stringContaining("AGENTS.md") },
        ]);
        expect(message.metadata).toHaveProperty("commandId");
        io[failure].mockRejectedValueOnce(new Error("storage failure"));
        return true;
      });
      const receipt = await submitSessionCommand(
        commandRequest("/init", startTask),
      );
      await expect(receipt.completed).rejects.toThrow("storage failure");
      expect(useChatStore.getState().runLockSessionIds[first.id]).toBe(true);
      await useChatStore.getState().commitMessages(first.id, []);
      expect(startTask).toHaveBeenCalledTimes(1);
      const writes = io.commit.mock.calls
        .flatMap(([file]) => file.messages)
        .filter(
          (record) =>
            record.role === "command" && record.content.phase === "result",
        );
      expect(writes).toHaveLength(failure === "commit" ? 2 : 1);
      expect(
        useCommandStore.getState().sessions[first.id][0].result?.status,
      ).toBe("success");
      expect(
        useChatStore.getState().runLockSessionIds[first.id],
      ).toBeUndefined();
    },
  );

  it("自动压缩期间拒绝普通发送与引导，不清除运行状态或等待后续新轮", async () => {
    openCommandSession(true);
    const coordinator = getAgentTurnCoordinator(first.id);
    coordinator.inbox.open();
    useChatStore.getState().patchAgentMeta(first.id, { compacting: true });
    const input = {
      id: "blocked",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "next" }],
    };
    expect(await sendChatMessage(first.id, input)).toBe(false);
    expect(steerChatMessage(first.id, input)).toBeNull();
    expect(
      useChatStore.getState().agentMetaBySession[first.id].compacting,
    ).toBe(true);
    expect(chats.get(first.id)?.messages).toEqual([]);
    await clearAgentTurnCoordinator(first.id);
  });

  it("命令准备阶段禁止改写或删除历史，停止后不再启动任务", async () => {
    openCommandSession();
    expect(canReviseHistory(first.id)).toBe(true);
    let acquire!: (value: boolean) => void;
    io.acquire.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          acquire = resolve;
        }),
    );
    const request = commandRequest("/init");
    const submitting = submitSessionCommand(request);
    await vi.waitFor(() => expect(acquire).toBeTypeOf("function"));
    expect(canReviseHistory(first.id)).toBe(false);
    useChatStore.getState().deleteSession(first.id);
    expect(io.remove).not.toHaveBeenCalled();
    await stopSession(first.id);
    acquire(true);
    const receipt = await submitting;
    expect(await receipt.completed).toMatchObject({
      status: "error",
      text: "commands.cancelled",
    });
    expect(request.startTask).not.toHaveBeenCalled();
    expect(useCommandStore.getState().active[first.id]).toBeUndefined();
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
  });

  it("等待中的命令拒绝重复提交，并可在获取运行锁前取消", async () => {
    openCommandSession(true);
    const request = commandRequest("/init");
    const receipt = await submitSessionCommand(request);
    expect(
      await sendChatMessage(first.id, {
        role: "user",
        parts: [{ type: "text", text: "next" }],
      }),
    ).toBe(false);
    await expect(
      submitSessionCommand(commandRequest("/compact")),
    ).rejects.toThrow();
    cancelSessionCommand(first.id);
    expect(await receipt.completed).toMatchObject({
      status: "error",
      text: "commands.cancelled",
    });
    expect(request.startTask).not.toHaveBeenCalled();
    expect(useCommandStore.getState().active[first.id]).toBeUndefined();
  });

  it("isolates parameter selections by session and model and restores their scalar choices", async () => {
    const a = { providerId: "builtin:deepseek", modelId: "a" };
    const b = { ...a, modelId: "b" };
    const store = useChatStore.getState();
    await Promise.all([
      store.setParameterSelections(first.id, a, { thinking: "off" }),
      store.setParameterSelections(first.id, b, { thinking: "omit" }),
      store.setParameterSelections(second.id, a, { thinking: "on" }),
    ]);
    const saved = useChatStore.getState().parameterSelectionsBySession;
    expect(saved[first.id][JSON.stringify([a.providerId, a.modelId])]).toEqual({
      thinking: "off",
    });
    expect(saved[first.id][JSON.stringify([b.providerId, b.modelId])]).toEqual({
      thinking: "omit",
    });
    expect(saved[second.id][JSON.stringify([a.providerId, a.modelId])]).toEqual(
      { thinking: "on" },
    );
    expect(io.workspaceSet).toHaveBeenLastCalledWith(
      `ai:parameters:${second.id}`,
      saved[second.id],
    );
    useChatStore.setState({ parameterSelectionsBySession: {} });
    io.workspaceGet.mockImplementation((key) =>
      key === `ai:parameters:${first.id}` ? saved[first.id] : undefined,
    );
    expect(getSessionParameterSelections(first.id)).toEqual(saved[first.id]);
    await seedSession(first.id);
    expect(
      useChatStore.getState().parameterSelectionsBySession[first.id],
    ).toEqual(saved[first.id]);
    await store.setParameterSelections(first.id, a, { thinking: "on" });
    expect(
      getSessionParameterSelections(first.id)[
        JSON.stringify([a.providerId, a.modelId])
      ],
    ).toEqual({ thinking: "on" });
  });

  it("中止已发布但协调器尚未释放时拒绝新引导", async () => {
    useChatStore.setState({
      sessions: [first],
      activeSessionId: first.id,
      runLockSessionIds: { [first.id]: true },
    });
    const coordinator = getAgentTurnCoordinator(first.id);
    coordinator.inbox.open();
    useChatStore.getState().patchAgentMeta(first.id, { cancelled: true });
    try {
      expect(
        steerChatMessage(first.id, {
          id: "late",
          role: "user",
          parts: [{ type: "text", text: "late guidance" }],
        }),
      ).toBeNull();
      expect(coordinator.inbox.hasPending).toBe(false);
    } finally {
      await clearAgentTurnCoordinator(first.id);
    }
  });

  it("关闭前提交失败时向调用方返回错误", async () => {
    const failure = new Error("session write failed");
    chats.set(first.id, {
      status: "ready",
      messages: [],
    } as never);
    useChatStore.setState({
      runLockSessionIds: { [first.id]: true },
      commitMessages: vi.fn().mockRejectedValue(failure),
    });

    await expect(flushCompletedSessionRuns()).rejects.toBe(failure);
    expect(useChatStore.getState().sessionSyncError).toBe(
      "Error: session write failed",
    );
  });

  it("reports a failed terminal commit to its session while retaining the run lock for retry", async () => {
    useChatStore.setState({
      sessions: [first],
      runLockSessionIds: { [first.id]: true },
    });
    sessionMetadata.set(first.id, { title: first.title });
    io.commit.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      useChatStore.getState().commitMessages(first.id, []),
    ).rejects.toThrow("disk full");
    expect(
      useChatStore.getState().agentMetaBySession[first.id].commitError,
    ).toContain("disk full");
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBe(true);
    expect(io.release).not.toHaveBeenCalled();
    await useChatStore.getState().commitMessages(first.id, []);
    expect(
      useChatStore.getState().agentMetaBySession[first.id]?.commitError,
    ).toBeUndefined();
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
  });

  it("压缩检查点保存失败后只补交原摘要，失败期间保持运行锁", async () => {
    useChatStore.setState({
      sessions: [first],
      activeSessionId: first.id,
      runLockSessionIds: { [first.id]: true },
    });
    sessionMetadata.set(first.id, { title: first.title });
    persistedMessageCounts.set(first.id, 1);
    const user: UIMessage = {
      id: "u",
      role: "user",
      parts: [{ type: "text", text: "request" }],
    };
    const assistant: UIMessage = {
      id: "a",
      role: "assistant",
      parts: [{ type: "step-start" }, { type: "text", text: "prefix" }],
    };
    const event: TurnEvent = {
      event: "compaction",
      id: "checkpoint",
      throughUserMessageId: "u",
      summary: "saved handoff",
    };
    const writes: SessionMessage[] = [];
    const chat = { status: "ready", messages: [user, assistant] };
    chats.set(first.id, chat as never);
    io.commit.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      useChatStore
        .getState()
        .persistTurnCheckpoint(first.id, [assistant], event),
    ).rejects.toThrow("disk full");
    expect(pendingTurns.get(first.id)?.committedParts).toBe(0);
    io.commit.mockRejectedValueOnce(new Error("still full"));
    await expect(
      useChatStore.getState().commitMessages(first.id, chat.messages),
    ).rejects.toThrow("still full");
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBe(true);
    expect(io.release).not.toHaveBeenCalled();
    io.commit.mockImplementation(async (file) => {
      writes.push(...file.messages);
      return first;
    });
    await useChatStore.getState().commitMessages(first.id, chat.messages);
    expect(
      writes.filter(
        (record) =>
          record.role === "event" && record.content.event === "compaction",
      ),
    ).toEqual([expect.objectContaining({ content: event })]);
    expect(writes.filter((record) => record.role === "assistant")).toHaveLength(
      1,
    );
    expect(
      JSON.stringify(await convertToAgentModelMessages(chat.messages)),
    ).toContain("saved handoff");
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
  });

  it("取消尚未保存的压缩候选时只保存原始历史", async () => {
    useChatStore.setState({
      sessions: [first],
      activeSessionId: first.id,
      runLockSessionIds: { [first.id]: true },
    });
    sessionMetadata.set(first.id, { title: first.title });
    const assistant: UIMessage = {
      id: "a",
      role: "assistant",
      parts: [{ type: "text", text: "original" }],
    };
    io.commit.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      useChatStore.getState().persistTurnCheckpoint(first.id, [assistant], {
        event: "compaction",
        id: "cancelled",
        throughUserMessageId: "u",
        summary: "discarded",
      }),
    ).rejects.toThrow("disk full");
    useChatStore.getState().patchAgentMeta(first.id, { cancelled: true });
    const writes: SessionMessage[] = [];
    io.commit.mockImplementation(async (file) => {
      writes.push(...file.messages);
      return first;
    });
    await useChatStore.getState().commitMessages(first.id, [assistant]);
    expect(
      writes.some(
        (record) =>
          record.role === "event" && record.content.event === "compaction",
      ),
    ).toBe(false);
    expect(JSON.stringify(writes)).toContain("original");
  });

  it("commits multiple checkpoints and the terminal tail exactly once, advancing only after success", async () => {
    useChatStore.setState({
      sessions: [first],
      runLockSessionIds: { [first.id]: true },
    });
    sessionMetadata.set(first.id, { title: first.title });
    persistedMessageCounts.set(first.id, 1);
    const writes: SessionMessage[] = [];
    io.commit.mockImplementation(async (file) => {
      writes.push(...file.messages);
      return first;
    });
    const initial: UIMessage = {
      id: "user",
      role: "user",
      parts: [{ type: "text", text: "Question" }],
    };
    let completed: UIMessage = {
      id: "assistant",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "Candidate", state: "done" },
      ],
    };
    const result: TurnEvent = {
      version: 1,
      event: "subagent_result",
      results: [
        {
          taskId: "task-1",
          label: "Inspector",
          status: "completed",
          result: "done",
        },
      ],
    };
    const checkpoint = useChatStore.getState().persistTurnCheckpoint;
    await checkpoint(first.id, [completed], result);
    expect(io.release).not.toHaveBeenCalled();
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBe(true);
    completed = {
      ...completed,
      parts: [
        ...completed.parts,
        conversationEventPart(result),
        { type: "step-start" },
        { type: "text", text: "Following up", state: "done" },
      ],
    };
    const guide: TurnEvent = {
      event: "user_steering",
      message: {
        id: "guide",
        role: "user",
        parts: [{ type: "text", text: "Correction" }],
      },
    };
    const cursor = pendingTurns.get(first.id)?.committedParts;
    io.commit.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(checkpoint(first.id, [completed], guide)).rejects.toThrow(
      "disk unavailable",
    );
    expect(pendingTurns.get(first.id)?.committedParts).toBe(cursor);
    await checkpoint(first.id, [completed], guide);
    completed = {
      ...completed,
      parts: [
        ...completed.parts,
        conversationEventPart(guide),
        { type: "step-start" },
        { type: "text", text: "Final", state: "done" },
      ],
    };
    io.release.mockRejectedValueOnce(new Error("unlock failed"));
    await expect(
      useChatStore.getState().commitMessages(first.id, [initial, completed]),
    ).rejects.toThrow("unlock failed");
    await useChatStore
      .getState()
      .commitMessages(first.id, [initial, completed]);
    expect(writes.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "assistant", content: "Candidate" },
      { role: "event", content: result },
      { role: "assistant", content: "Following up" },
      { role: "user", content: "Correction" },
      { role: "assistant", content: "Final" },
    ]);
    expect(writes[3]).toMatchObject({ guided: true, message_id: "guide" });
    expect(pendingTurns.has(first.id)).toBe(false);
    expect(io.release).toHaveBeenCalledTimes(2);
    expect(
      await convertToAgentModelMessages(
        projectSessionMessages(first.id, writes),
      ),
    ).toEqual(await convertToAgentModelMessages([completed]));
  });

  it("materializes subagent cards without persisting a second display authority", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const messages = [
      {
        id: "user-1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "inspect" }],
      },
      {
        id: "assistant-1",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-run_subagent" as const,
            toolCallId: "parent-call",
            state: "output-available" as const,
            input: { task: "inspect", wait: false },
            output: { taskId: "task-1", status: "running" },
          },
        ],
      },
    ];
    const chat = { status: "ready", messages } as never;
    chats.set(first.id, chat);
    persistedMessageCounts.set(first.id, 1);
    pendingTurns.set(first.id, { id: "turn-1", committedParts: 0 });
    useChatStore.setState({
      sessions: [first],
      runLockSessionIds: { [first.id]: true },
      refreshSessions: refresh,
      activeSessionId: first.id,
      subagentDisplaysBySession: {
        [first.id]: {
          "parent-call": {
            taskId: "task-1",
            toolCallId: "parent-call",
            label: "Inspector",
            status: "completed",
            phase: "thinking",
            startedAt: 100,
            durationMs: 900,
            result: "done",
            steps: [
              {
                id: "child-call",
                toolName: "grep",
                status: "completed",
              },
            ],
          },
        },
      },
    });

    await useChatStore.getState().commitMessages(first.id, messages);

    expect(io.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: "assistant" }),
          expect.objectContaining({ role: "tool", name: "run_subagent" }),
        ],
      }),
    );
    expect(
      (chats.get(first.id)?.messages[1].parts ?? []).map((part) => part.type),
    ).toEqual(["tool-run_subagent", "data-subagent-display"]);
    expect(
      useChatStore.getState().subagentDisplaysBySession[first.id],
    ).toBeUndefined();
  });

  it("restores only the session recorded by the primary window", async () => {
    io.list.mockResolvedValue([first, second]);
    io.workspaceGet.mockReturnValue(second.id);

    await useChatStore.getState().hydrateSessions();

    expect(useChatStore.getState().activeSessionId).toBe(second.id);
    expect(io.read).toHaveBeenCalledWith(second.id);
    expect(io.workspaceSet).not.toHaveBeenCalled();
  });

  it("opens a draft when the primary window has no recorded session", async () => {
    io.list.mockResolvedValue([first, second]);

    await useChatStore.getState().hydrateSessions();

    expect(useChatStore.getState().activeSessionId).toBe(
      useChatStore.getState().draftSessionId,
    );
    expect(io.read).not.toHaveBeenCalled();
  });

  it("clears a missing primary selection and opens a draft", async () => {
    io.list.mockResolvedValue([first]);
    io.workspaceGet.mockReturnValue(second.id);

    await useChatStore.getState().hydrateSessions();

    expect(useChatStore.getState().activeSessionId).toBe(
      useChatStore.getState().draftSessionId,
    );
    expect(io.workspaceDelete).toHaveBeenCalledOnce();
  });

  it("restores the recorded session in a temporary window with retained state", async () => {
    io.isPrimary = false;
    io.list.mockResolvedValue([first, second]);
    io.workspaceGet.mockReturnValue(first.id);

    await useChatStore.getState().hydrateSessions();

    expect(useChatStore.getState().sessions).toEqual([first, second]);
    expect(useChatStore.getState().activeSessionId).toBe(first.id);
    expect(io.workspaceGet).toHaveBeenCalledWith("ai:activeSessionId");
    expect(io.read).toHaveBeenCalledWith(first.id);
  });

  it("persists temporary window selection and clears it when opening a draft", async () => {
    io.isPrimary = false;
    useChatStore.setState({ sessions: [first], chatViewVisible: false });
    useChatStore.getState().switchSession(first.id);
    await vi.waitFor(() =>
      expect(io.workspaceSet).toHaveBeenCalledWith(
        "ai:activeSessionId",
        first.id,
      ),
    );
    useChatStore.getState().newSession();
    await vi.waitFor(() =>
      expect(io.workspaceDelete).toHaveBeenCalledWith("ai:activeSessionId"),
    );
  });

  it("opens an unlisted draft when no persisted session exists", async () => {
    await useChatStore.getState().hydrateSessions();

    expect(useChatStore.getState().sessions).toEqual([]);
    expect(useChatStore.getState().activeSessionId).toBeTruthy();
    expect(useChatStore.getState().draftSessionId).toBe(
      useChatStore.getState().activeSessionId,
    );
    expect(io.workspaceSet).not.toHaveBeenCalled();
  });

  it("seeds a new draft with the recent desktop model parameters", () => {
    const model = { providerId: "openai", modelId: "gpt-5" };
    usePreferencesStore.setState({
      desktopModel: model,
      desktopModelParameterSelections: { reasoning: "high" },
    });

    const draftId = useChatStore.getState().newSession();

    expect(
      useChatStore.getState().parameterSelectionsBySession[draftId],
    ).toEqual({
      [modelRefKey(model)]: { reasoning: "high" },
    });
  });

  it("persists the active desktop model and parameter selection atomically", async () => {
    const model = { providerId: "openai", modelId: "gpt-5" };
    const draftId = useChatStore.getState().newSession();
    useChatStore.setState({ selectedModel: model });

    await useChatStore
      .getState()
      .setParameterSelections(draftId, model, { reasoning: "high" });

    expect(io.sharedMutate).toHaveBeenLastCalledWith("settings", [
      { kind: "set", key: "desktopModel", value: model },
      {
        kind: "set",
        key: "desktopModelParameterSelections",
        value: { reasoning: "high" },
      },
    ]);
  });

  it("allows leaving a running session but prevents deleting that session", async () => {
    useChatStore.setState({
      sessions: [first, second],
      activeSessionId: first.id,
    });
    await useChatStore.getState().beginSessionRun(first.id);

    const draftId = useChatStore.getState().newSession();
    expect(draftId).not.toBe(first.id);
    expect(useChatStore.getState().activeSessionId).toBe(draftId);
    useChatStore.getState().switchSession(second.id);
    await vi.waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe(second.id);
    });
    useChatStore.getState().deleteSession(first.id);

    expect(useChatStore.getState().sessions).toHaveLength(2);
    expect(io.remove).not.toHaveBeenCalled();
  });

  it("keeps a new session as one unlisted draft until a user message is sent", async () => {
    useChatStore.setState({ sessions: [first], activeSessionId: first.id });

    const draftId = useChatStore.getState().newSession();

    expect(useChatStore.getState().activeSessionId).toBe(draftId);
    expect(useChatStore.getState().draftSessionId).toBe(draftId);
    expect(useChatStore.getState().sessions).toEqual([first]);
    expect(useChatStore.getState().newSession()).toBe(draftId);
    expect(useChatStore.getState().sessions).toEqual([first]);

    useChatStore.getState().promoteSession(
      draftId,
      [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      ],
      "D:/workspace/draft",
    );

    expect(useChatStore.getState().draftSessionId).toBeNull();
    expect(useChatStore.getState().sessions[0]).toMatchObject({
      id: draftId,
      title: "hello",
      cwd: "D:/workspace/draft",
    });
    await vi.waitFor(() =>
      expect(io.workspaceSet).toHaveBeenLastCalledWith(
        "ai:activeSessionId",
        draftId,
      ),
    );
  });

  it("clears the persisted selection when creating a new session", async () => {
    useChatStore.setState({ sessions: [first], activeSessionId: first.id });

    useChatStore.getState().newSession();

    await vi.waitFor(() => expect(io.workspaceDelete).toHaveBeenCalledOnce());
  });

  it("freezes the selected Custom Agent when a draft becomes a session", () => {
    const draftId = "44444444-4444-4444-8444-444444444444";
    useAgentsStore.setState({
      agents: [
        {
          id: "a-review",
          name: "Reviewer",
          description: "Review code",
          instructions: "Review carefully.",
          workspaceFiles: ["AGENTS.md"],
          icon: "reviewer",
          tools: ["read_file", "grep"],
        },
      ],
      draftAgentId: "a-review",
    });
    useChatStore.setState({
      sessions: [],
      draftSessionId: draftId,
      activeSessionId: draftId,
    });

    useChatStore.getState().promoteSession(
      draftId,
      [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "review" }],
        },
      ],
      "D:/workspace/draft",
    );

    expect(useChatStore.getState().sessions[0]).toMatchObject({
      agentId: "a-review",
      agentName: "Reviewer",
      agentIcon: "reviewer",
    });
    expect(sessionMetadata.get(draftId)?.agent).toEqual({
      id: "a-review",
      name: "Reviewer",
      icon: "reviewer",
    });
    expect(useAgentsStore.getState().draftAgentId).toBe(MAIN_AGENT_ID);
  });

  it("persists the user message and system prompt before the assistant response", async () => {
    useChatStore.setState({
      sessions: [first],
      activeSessionId: first.id,
      runLockSessionIds: { [first.id]: true },
    });

    const user = {
      id: "m1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "hello" }],
    };
    await useChatStore
      .getState()
      .persistSubmittedTurn(first.id, [user], "prompt for this turn");

    const firstCommit = io.commit.mock.calls[0][0];
    expect(firstCommit).toEqual(
      expect.objectContaining({
        cwd: "D:/workspace/first",
        metadata: expect.objectContaining({
          systemPrompt: "prompt for this turn",
        }),
        messages: [
          expect.objectContaining({
            role: "user",
            content: "hello",
            turn_id: expect.stringMatching(/^turn_[0-9a-f]{12}$/),
          }),
        ],
      }),
    );
    expect(persistedMessageCounts.get(first.id)).toBe(1);

    const assistant = {
      id: "a1",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "answer" }],
    };
    await useChatStore
      .getState()
      .persistSubmittedTurn(first.id, [user, assistant], "updated prompt");
    expect(io.commit.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ systemPrompt: "updated prompt" }),
        messages: [],
      }),
    );
    expect(persistedMessageCounts.get(first.id)).toBe(1);

    await useChatStore.getState().commitMessages(first.id, [user, assistant]);
    const finalCommit = io.commit.mock.calls[2][0];
    expect(finalCommit.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "answer",
        turn_id: firstCommit.messages[0].turn_id,
      }),
    ]);
    expect(finalCommit.metadata.systemPrompt).toBe("updated prompt");
  });

  it("preserves the active draft when deleting the final history item", async () => {
    const draftId = "draft-11111111-1111-4111-8111-111111111111";
    useChatStore.setState({
      sessions: [first],
      activeSessionId: draftId,
      draftSessionId: draftId,
    });

    useChatStore.getState().deleteSession(first.id);
    await vi.waitFor(() => {
      expect(useChatStore.getState().sessions).toEqual([]);
    });

    expect(useChatStore.getState().activeSessionId).toBe(draftId);
    expect(useChatStore.getState().draftSessionId).toBe(draftId);
    expect(io.clearProcesses).toHaveBeenCalledWith(first.id);
  });

  it("keeps the observable run lock when Rust release fails", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      sessions: [first],
      activeSessionId: first.id,
      runLockSessionIds: { [first.id]: true },
      refreshSessions: refresh,
    });
    io.release.mockRejectedValueOnce(new Error("release failed"));

    await expect(
      useChatStore
        .getState()
        .commitMessages(first.id, [
          { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
        ]),
    ).rejects.toThrow("release failed");
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(io.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: "user",
            content: "hi",
            turn_id: expect.stringMatching(/^turn_[0-9a-f]{12}$/),
          }),
        ],
      }),
    );

    await useChatStore
      .getState()
      .commitMessages(first.id, [
        { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ]);
    expect(io.commit).toHaveBeenLastCalledWith(
      expect.objectContaining({ messages: [] }),
    );
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("allows a later run after another process releases the lock", async () => {
    io.acquire.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await useChatStore.getState().beginSessionRun(first.id)).toBe(false);
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
    expect(await useChatStore.getState().beginSessionRun(first.id)).toBe(true);
    expect(await useChatStore.getState().beginSessionRun(first.id)).toBe(false);
    expect(io.acquire).toHaveBeenCalledTimes(2);
  });

  it("refuses deletion of a bound Channel before cleaning up its processes", async () => {
    const channelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    io.sharedRead.mockResolvedValue({ [channelId]: { sessionId: first.id } });
    useChatStore.setState({ sessions: [{ ...first, channelId }] });
    useChatStore.getState().deleteSession(first.id);
    await vi.waitFor(() =>
      expect(useChatStore.getState().sessionSyncError).not.toBeNull(),
    );
    expect(io.clearProcesses).not.toHaveBeenCalled();
    expect(io.remove).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions).toHaveLength(1);
  });

  it("only the bound Channel can submit its session in the permanent Local window", async () => {
    const channelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    useChatStore.setState({
      sessions: [{ ...first, channelId }],
      activeSessionId: first.id,
    });
    expect(isSessionWritable(first.id)).toBe(false);
    expect(await useChatStore.getState().beginSessionRun(first.id)).toBe(false);
    expect(
      await useChatStore
        .getState()
        .beginSessionRun(first.id, "another-channel"),
    ).toBe(false);
    io.isPrimary = false;
    expect(
      await useChatStore.getState().beginSessionRun(first.id, channelId),
    ).toBe(false);
    io.isPrimary = true;
    expect(
      await useChatStore.getState().beginSessionRun(first.id, channelId),
    ).toBe(true);
    expect(io.acquire).toHaveBeenCalledTimes(1);
  });

  it("rejects a run owned by another workspace environment", async () => {
    useChatStore.setState({
      sessions: [{ ...first, environmentKey: "wsl:Ubuntu" }],
      activeSessionId: first.id,
    });

    await expect(
      useChatStore.getState().beginSessionRun(first.id),
    ).resolves.toBe(false);
    expect(io.acquire).not.toHaveBeenCalled();
  });

  it("keeps the active Chat after committing its own turn", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const chat = { stop, status: "ready", messages: [] } as never;
    const committed = { ...first, updatedAt: 3, fingerprint: "disk:committed" };
    chats.set(first.id, chat);
    io.commit.mockResolvedValue(committed);
    io.list.mockResolvedValue([committed]);
    useChatStore.setState({
      sessions: [first],
      activeSessionId: first.id,
      activeSessionRevision: 0,
      runLockSessionIds: { [first.id]: true },
    });

    await useChatStore
      .getState()
      .commitMessages(first.id, [
        { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ]);

    expect(chats.get(first.id)).toBe(chat);
    expect(stop).not.toHaveBeenCalled();
    expect(useChatStore.getState().activeSessionRevision).toBe(0);
    expect(useChatStore.getState().sessions[0]).toEqual(committed);
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
  });

  it("keeps the latest session choice when an older read finishes later", async () => {
    let resolveSecond: (value: ReturnType<typeof sessionFile>) => void = () =>
      undefined;
    io.read.mockImplementation((id: string) =>
      id === second.id
        ? new Promise((resolve) => {
            resolveSecond = resolve;
          })
        : Promise.resolve(sessionFile(id === first.id ? first : third)),
    );
    useChatStore.setState({
      sessions: [first, second, third],
      activeSessionId: first.id,
    });

    useChatStore.getState().switchSession(second.id);
    useChatStore.getState().switchSession(third.id);
    await vi.waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe(third.id);
    });
    resolveSecond(sessionFile(second));
    await Promise.resolve();

    expect(useChatStore.getState().activeSessionId).toBe(third.id);
  });

  it("does not switch to a session whose history cannot be read", async () => {
    io.read.mockRejectedValueOnce(new Error("read failed"));
    useChatStore.setState({
      sessions: [first, second],
      activeSessionId: first.id,
    });

    useChatStore.getState().switchSession(second.id);
    await vi.waitFor(() => {
      expect(useChatStore.getState().sessionSyncError).toBe(
        "Error: read failed",
      );
    });

    expect(useChatStore.getState().activeSessionId).toBe(first.id);
  });

  it("releases a completed background Chat before the next disk refresh", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    chats.set(second.id, { stop, status: "ready", messages: [] } as never);
    useChatStore.setState({
      sessions: [first, second],
      activeSessionId: first.id,
      runLockSessionIds: {},
    });
    io.list.mockResolvedValue([
      first,
      { ...second, updatedAt: 3, fingerprint: "disk:changed" },
    ]);

    await useChatStore.getState().refreshSessions();

    expect(stop).not.toHaveBeenCalled();
    expect(chats.has(second.id)).toBe(false);
    expect(io.clearProcesses).not.toHaveBeenCalled();
  });

  it("releases hidden completed history but retains an unsaved background run", async () => {
    useChatStore.setState({
      sessions: [first, second],
      activeSessionId: first.id,
      runLockSessionIds: { [second.id]: true },
    });
    const completed = { status: "ready", messages: [] } as never;
    const unsaved = { status: "ready", messages: [] } as never;
    chats.set(first.id, completed);
    chats.set(second.id, unsaved);
    sessionMetadata.set(first.id, { title: "first" });
    persistedMessageCounts.set(first.id, 1);
    useChatStore.getState().setChatViewVisible(false);
    expect(chats.has(first.id)).toBe(false);
    expect(sessionMetadata.has(first.id)).toBe(false);
    expect(persistedMessageCounts.has(first.id)).toBe(false);
    expect(chats.get(second.id)).toBe(unsaved);
    useChatStore
      .getState()
      .patchAgentMeta(second.id, { commitError: "disk full" });
    useChatStore.getState().newSession();
    expect(chats.get(second.id)).toBe(unsaved);
  });

  it("cold-loads released history once when the foreground reopens concurrently", async () => {
    useChatStore.setState({ sessions: [first], activeSessionId: first.id });
    const initial = await loadChat(first.id);
    useChatStore.getState().setChatViewVisible(false);
    expect(chats.has(first.id)).toBe(false);
    useChatStore.getState().setChatViewVisible(true);
    const [left, right] = await Promise.all([
      loadChat(first.id),
      loadChat(first.id),
    ]);
    expect(left).toBe(right);
    expect(left).not.toBe(initial);
    expect(io.read).toHaveBeenCalledTimes(2);
  });

  it("多个页面共用实例，关闭 AI 页面不会回收仍被消息通道观察的会话", async () => {
    useChatStore.setState({ sessions: [first], activeSessionId: first.id });
    const releaseOne = retainSessionView(first.id);
    const releaseTwo = retainSessionView(first.id);
    try {
      const chat = await loadChat(first.id);
      useChatStore.getState().setChatViewVisible(false);
      releaseOne();
      expect(chats.get(first.id)).toBe(chat);
      expect(await loadChat(first.id)).toBe(chat);
      expect(io.read).toHaveBeenCalledTimes(1);
    } finally {
      releaseTwo();
    }
    expect(chats.has(first.id)).toBe(false);
  });

  it("冷读取期间删除会话不会重新创建旧实例或恢复旧展示记录", async () => {
    useChatStore.setState({ sessions: [first], activeSessionId: first.id });
    let resolve!: (value: ReturnType<typeof sessionFile>) => void;
    io.read.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const loading = loadChat(first.id);
    const failed = expect(loading).rejects.toThrow("no longer available");
    useChatStore.setState({ sessions: [], activeSessionId: null });
    resolve(sessionFile(first));
    await failed;
    expect(chats.has(first.id)).toBe(false);
    expect(seedMessages.has(first.id)).toBe(false);
  });

  it("冷读取遇到新文件版本只恢复最新内容", async () => {
    useChatStore.setState({ sessions: [first], activeSessionId: first.id });
    let resolve!: (value: ReturnType<typeof sessionFile>) => void;
    io.read.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const loading = loadChat(first.id);
    const updated = { ...first, fingerprint: "new-version" };
    useChatStore.setState({ sessions: [updated] });
    io.read.mockResolvedValue({
      ...sessionFile(updated),
      messages: [
        {
          role: "user",
          message_id: "latest",
          timestamp: new Date().toISOString(),
          content: "latest text",
        },
      ],
    });
    resolve(sessionFile(first));
    const chat = await loading;
    expect(chat.messages[0]).toMatchObject({
      id: "latest",
      parts: [{ type: "text", text: "latest text" }],
    });
    expect(io.read).toHaveBeenCalledTimes(2);
  });

  it("外部会话替换使消息、命令和投递展示缓存一并失效", async () => {
    useChatStore.setState({
      sessions: [first],
      activeSessionId: first.id,
      chatViewVisible: false,
    });
    const release = retainSessionView(first.id);
    try {
      await loadChat(first.id);
      useDeliveryHistory.setState({ sessions: { [first.id]: [] } });
      useCommandStore.setState({ sessions: { [first.id]: [] } });
      io.list.mockResolvedValue([{ ...first, fingerprint: "changed" }]);
      await useChatStore.getState().refreshSessions();
      expect(chats.has(first.id)).toBe(false);
      expect(useDeliveryHistory.getState().sessions[first.id]).toBeUndefined();
      expect(useCommandStore.getState().sessions[first.id]).toBeUndefined();
    } finally {
      release();
    }
  });

  it("does not project hidden history during hydration or selection", async () => {
    useChatStore.setState({ chatViewVisible: false });
    io.list.mockResolvedValue([first, second]);
    io.workspaceGet.mockReturnValue(first.id);
    await useChatStore.getState().hydrateSessions();
    useChatStore.getState().switchSession(second.id);
    expect(useChatStore.getState().activeSessionId).toBe(second.id);
    expect(io.read).not.toHaveBeenCalled();
    expect(seedMessages.size).toBe(0);
  });

  it("loads an external binding before validating built-in model credentials", async () => {
    useChatStore.setState({
      sessions: [first],
      activeSessionId: first.id,
      selectedModel: null,
    });
    const file = sessionFile(first);
    io.read.mockResolvedValue({
      ...file,
      metadata: {
        ...file.metadata,
        externalAgent: { agentId: "claude", sessionId: "external" },
      },
    });
    io.acquire.mockResolvedValue(false);
    expect(await startChatMessage(first.id, { text: "continue" })).toBe(false);
    expect(io.acquire).toHaveBeenCalledWith(first.id);
  });

  it("ignores a stale disk seed once a Chat owns the current history", async () => {
    let resolve!: (value: ReturnType<typeof sessionFile>) => void;
    io.read.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const reading = seedSession(first.id);
    chats.set(first.id, { status: "streaming", messages: [] } as never);
    persistedMessageCounts.set(first.id, 3);
    sessionMetadata.set(first.id, { title: "current" });
    resolve(sessionFile(first));
    await reading;
    expect(persistedMessageCounts.get(first.id)).toBe(3);
    expect(sessionMetadata.get(first.id)?.title).toBe("current");
    expect(seedMessages.has(first.id)).toBe(false);
  });

  it("retains a cold Chat when the abandoned view completes before a pending send", async () => {
    useChatStore.setState({
      sessions: [first],
      activeSessionId: first.id,
      selectedModel: { providerId: "builtin:ollama", modelId: "test" },
    });
    let resolve!: (value: ReturnType<typeof sessionFile>) => void;
    io.read.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const abandonedView = loadChat(first.id).then(releaseUnusedChats);
    const sending = startChatMessage(first.id, { text: "continue" });
    useChatStore.getState().setChatViewVisible(false);
    io.acquire.mockImplementation(async () => {
      expect(chats.has(first.id)).toBe(true);
      expect(sessionMetadata.has(first.id)).toBe(true);
      return false;
    });
    resolve(sessionFile(first));
    await abandonedView;
    expect(await sending).toBe(false);
    expect(io.acquire).toHaveBeenCalledWith(first.id);
    expect(chats.has(first.id)).toBe(false);
  });

  it("does not evict a Chat while native run acquisition is pending", async () => {
    let resolve!: (value: boolean) => void;
    io.acquire.mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done;
      }),
    );
    useChatStore.setState({ sessions: [first], activeSessionId: first.id });
    const chat = { status: "ready", messages: [] } as never;
    chats.set(first.id, chat);
    const acquiring = useChatStore.getState().beginSessionRun(first.id);
    useChatStore.getState().setChatViewVisible(false);
    expect(chats.get(first.id)).toBe(chat);
    resolve(true);
    expect(await acquiring).toBe(true);
    expect(chats.get(first.id)).toBe(chat);
  });

  it("账号重新配置实例后仍保护原历史，移除账号配置后允许删除", async () => {
    const { channelOwnerId } = await import("@/modules/channels/identity");
    const connection = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "weixin" as const,
      accountId: "owner",
      name: "replacement",
      enabled: false,
      busyMessageMode: "queue",
    };
    useChatStore.setState({
      sessions: [{ ...first, channelId: await channelOwnerId(connection) }],
      activeSessionId: first.id,
    });
    io.sharedRead.mockResolvedValue({ [connection.id]: connection });
    useChatStore.getState().deleteSession(first.id);
    await vi.waitFor(() =>
      expect(useChatStore.getState().sessionSyncError).toBeTruthy(),
    );
    expect(io.remove).not.toHaveBeenCalled();
    io.sharedRead.mockResolvedValue({});
    useChatStore.getState().deleteSession(first.id);
    await vi.waitFor(() => expect(io.remove).toHaveBeenCalledWith(first.id));
  });

  it("opens a draft after deleting the active session", async () => {
    useChatStore.setState({
      sessions: [first, second],
      activeSessionId: first.id,
      runLockSessionIds: {},
    });

    useChatStore.getState().deleteSession(first.id);
    await vi.waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe(
        useChatStore.getState().draftSessionId,
      );
    });

    expect(useChatStore.getState().sessions).toEqual([second]);
    expect(io.read).not.toHaveBeenCalledWith(second.id);
    expect(io.workspaceDelete).toHaveBeenCalledWith(
      `ai:parameters:${first.id}`,
    );
    expect(io.workspaceDelete).toHaveBeenCalledWith("ai:activeSessionId");
  });

  it("opens a draft when refresh observes the active session was deleted", async () => {
    useChatStore.setState({
      sessions: [first, second],
      activeSessionId: first.id,
      draftSessionId: null,
      runLockSessionIds: {},
    });
    useSessionAttentionStore.getState().markBackgroundRunning(first.id);
    io.list.mockResolvedValue([second]);

    await useChatStore.getState().refreshSessions();

    expect(useChatStore.getState().sessions).toEqual([second]);
    expect(useChatStore.getState().activeSessionId).toBe(
      useChatStore.getState().draftSessionId,
    );
    expect(io.clearProcesses).toHaveBeenCalledWith(first.id);
    expect(
      useChatStore.getState().agentMetaBySession[first.id],
    ).toBeUndefined();
    expect(
      useSessionAttentionStore.getState().bySession[first.id],
    ).toBeUndefined();
    expect(io.workspaceDelete).toHaveBeenCalledOnce();
  });
});
