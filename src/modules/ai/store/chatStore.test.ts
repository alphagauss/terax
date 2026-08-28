/**
 * 本文件验证 AI 会话的窗口级恢复、多进程同步、运行锁和两阶段发布。
 * 测试锁定临时窗口与失效选择回退草稿，以及运行和持久化的关键顺序。
 */

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
}));

vi.mock("../lib/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sessions")>()),
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
  }),
  getWorkspaceValue: io.workspaceGet,
  setWorkspaceValue: io.workspaceSet,
  deleteWorkspaceValue: io.workspaceDelete,
}));

vi.mock("../lib/modelPrefs", () => ({ pushRecentModel: vi.fn() }));

import {
  chats,
  flushCompletedSessionRuns,
  pendingTurnIds,
  persistedMessageCounts,
  seedMessages,
  sessionMetadata,
  useChatStore,
} from "./chatStore";
import type { SessionMeta } from "../lib/sessions";

const realRefreshSessions = useChatStore.getState().refreshSessions;
const realCommitMessages = useChatStore.getState().commitMessages;
const realPersistSubmittedTurn = useChatStore.getState().persistSubmittedTurn;

const first: SessionMeta = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "First",
  createdAt: 1,
  updatedAt: 2,
  environmentKey: "local",
  cwd: "D:/workspace/first",
  fingerprint: "disk:1",
};
const second: SessionMeta = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Second",
  createdAt: 1,
  updatedAt: 1,
  environmentKey: "local",
  cwd: "D:/workspace/second",
  fingerprint: "disk:2",
};
const third: SessionMeta = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Third",
  createdAt: 1,
  updatedAt: 0,
  environmentKey: "local",
  cwd: "D:/workspace/third",
  fingerprint: "disk:3",
};

const sessionFile = (meta: SessionMeta) => ({
  id: meta.id,
  createdAt: meta.createdAt,
  updatedAt: meta.updatedAt,
  environmentKey: meta.environmentKey,
  cwd: meta.cwd,
  metadata: { title: meta.title, todos: [] },
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
    io.acquire.mockResolvedValue(true);
    io.release.mockResolvedValue(undefined);
    io.list.mockResolvedValue([]);
    io.commit.mockImplementation(
      async (session: {
        id: string;
        cwd: string;
        metadata: { title: string };
        updatedAt: number;
      }) => ({
        id: session.id,
        title: session.metadata.title,
        createdAt: 1,
        updatedAt: session.updatedAt,
        environmentKey: "local",
        cwd: session.cwd,
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
      sessionSyncError: null,
      refreshSessions: realRefreshSessions,
      commitMessages: realCommitMessages,
      persistSubmittedTurn: realPersistSubmittedTurn,
    });
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
    io.list.mockResolvedValue([second]);

    await useChatStore.getState().refreshSessions();

    expect(useChatStore.getState().sessions).toEqual([second]);
    expect(useChatStore.getState().activeSessionId).toBe(
      useChatStore.getState().draftSessionId,
    );
    expect(io.workspaceDelete).toHaveBeenCalledOnce();
  });
});
