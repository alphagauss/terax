/**
 * 本文件验证 AI 会话的窗口级恢复、多进程同步、运行锁和两阶段发布。
 * 测试锁定临时窗口与失效选择回退草稿，以及运行和持久化的关键顺序。
 */

import {
  getAgentTurnCoordinator,
  clearAgentTurnCoordinator,
} from "@/modules/ai/agents/subagentRuntime";
import { steerChatMessage } from "@/modules/ai/store/chatRuntime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
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
}));

vi.mock("@/lib/sharedStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sharedStore")>()),
  readSharedStore: io.sharedRead,
}));

vi.mock("@/modules/ai/lib/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/ai/lib/sessions")>()),
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

import { MAIN_AGENT_ID } from "@/modules/ai/lib/agents";
import type { SessionMeta } from "@/modules/ai/lib/sessions";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import {
  chats,
  flushCompletedSessionRuns,
  isSessionWritable,
  pendingTurnIds,
  persistedMessageCounts,
  seedMessages,
  sessionMetadata,
  useChatStore,
} from "@/modules/ai/store/chatStore";
import { useSessionAttentionStore } from "@/modules/ai/store/sessionAttentionStore";

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
    pendingTurnIds.clear();
    useAgentsStore.setState({
      customAgents: [],
      draftAgentId: MAIN_AGENT_ID,
    });
    useSessionAttentionStore.setState({
      bySession: {},
      revealLatestBySession: {},
      pendingCompletions: [],
    });
    io.sharedRead.mockResolvedValue({});
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
      sessionsHydrated: false,
      draftSessionId: null,
      sessions: [],
      activeSessionId: null,
      activeSessionRevision: 0,
      runLockSessionIds: {},
      agentMetaBySession: {},
      subagentDisplaysBySession: {},
      sessionAgentFilter: null,
      sessionSyncError: null,
      refreshSessions: realRefreshSessions,
      commitMessages: realCommitMessages,
      persistSubmittedTurn: realPersistSubmittedTurn,
      persistTurnCheckpoint: realPersistTurnCheckpoint,
    });
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

  it("checkpoints completed steps and subagent results without releasing the turn", async () => {
    useChatStore.setState({
      sessions: [first],
      runLockSessionIds: { [first.id]: true },
    });
    sessionMetadata.set(first.id, { title: first.title });
    pendingTurnIds.set(first.id, "turn-1");

    await useChatStore.getState().persistTurnCheckpoint(
      first.id,
      [
        {
          id: "assistant-cycle",
          role: "assistant",
          parts: [
            { type: "step-start" },
            { type: "text", text: "Candidate", state: "done" },
          ],
        },
      ],
      {
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
      },
    );

    expect(io.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: first.id,
        messages: [
          expect.objectContaining({ role: "assistant", content: "Candidate" }),
          expect.objectContaining({
            role: "user",
            injected_event: "subagent_result",
            subagent_task_ids: ["task-1"],
          }),
        ],
      }),
    );
    expect(io.release).not.toHaveBeenCalled();
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBe(true);
  });

  it("persists final subagent display snapshots once and materializes the active chat", async () => {
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
    pendingTurnIds.set(first.id, "turn-1");
    useChatStore.setState({
      sessions: [first],
      runLockSessionIds: { [first.id]: true },
      refreshSessions: refresh,
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
          expect.objectContaining({
            role: "display",
            display_event: "subagent",
            subagent_display: expect.objectContaining({
              taskId: "task-1",
              status: "completed",
            }),
          }),
        ],
      }),
    );
    const displayRecord = io.commit.mock.calls[0][0].messages.find(
      (record: { role?: string }) => record.role === "display",
    );
    expect(displayRecord.subagent_display).not.toHaveProperty("task");
    expect(displayRecord.subagent_display).not.toHaveProperty("result");
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

  it("always opens a draft in a temporary window", async () => {
    io.isPrimary = false;
    io.list.mockResolvedValue([first, second]);
    io.workspaceGet.mockReturnValue(first.id);

    await useChatStore.getState().hydrateSessions();

    expect(useChatStore.getState().sessions).toEqual([first, second]);
    expect(useChatStore.getState().activeSessionId).toBe(
      useChatStore.getState().draftSessionId,
    );
    expect(io.workspaceGet).not.toHaveBeenCalled();
    expect(io.read).not.toHaveBeenCalled();
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
      customAgents: [
        {
          id: "a-review",
          name: "Reviewer",
          description: "Review code",
          instructions: "Review carefully.",
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
      instructions: "Review carefully.",
      icon: "reviewer",
      tools: ["read_file", "grep"],
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

  it("evicts an inactive cached Chat when its disk fingerprint changes", async () => {
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

    expect(stop).toHaveBeenCalledOnce();
    expect(chats.has(second.id)).toBe(false);
    expect(io.clearProcesses).not.toHaveBeenCalled();
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
    expect(io.workspaceDelete).toHaveBeenCalledOnce();
  });

  it("opens a draft when refresh observes the active session was deleted", async () => {
    useChatStore.setState({
      sessions: [first, second],
      activeSessionId: first.id,
      draftSessionId: null,
      runLockSessionIds: {},
    });
    useChatStore.getState().patchAgentMeta(first.id, { step: "Reading" });
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
