/**
 * 本文件验证 AI 会话在多进程场景下的运行锁、缓存失效和终态发布。
 * 测试确保 JSONL 记录缓存不会跨用例泄漏，并锁定发布失败时的锁语义。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  list: vi.fn(),
  commit: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
  workspaceGet: vi.fn(),
  workspaceSet: vi.fn(),
}));

vi.mock("../lib/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sessions")>()),
  acquireSessionRun: io.acquire,
  releaseSessionRun: io.release,
  listSessions: io.list,
  commitSession: io.commit,
  readSession: io.read,
  deleteSessionFile: io.remove,
}));

vi.mock("@/modules/workspace-process", () => ({
  getWorkspaceValue: io.workspaceGet,
  setWorkspaceValue: io.workspaceSet,
}));

vi.mock("../lib/modelPrefs", () => ({ pushRecentModel: vi.fn() }));

import {
  chats,
  flushCompletedSessionRuns,
  persistedMessageCounts,
  seedMessages,
  useChatStore,
} from "./chatStore";
import type { SessionMeta } from "../lib/sessions";

const realRefreshSessions = useChatStore.getState().refreshSessions;
const realCommitMessages = useChatStore.getState().commitMessages;

const first: SessionMeta = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "First",
  createdAt: 1,
  updatedAt: 2,
  fingerprint: "disk:1",
};
const second: SessionMeta = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Second",
  createdAt: 1,
  updatedAt: 1,
  fingerprint: "disk:2",
};

const sessionFile = (meta: SessionMeta) => ({
  id: meta.id,
  title: meta.title,
  createdAt: meta.createdAt,
  updatedAt: meta.updatedAt,
  messages: [],
  todos: [],
});

describe("chat store multi-process lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chats.clear();
    seedMessages.clear();
    persistedMessageCounts.clear();
    io.acquire.mockResolvedValue(true);
    io.release.mockResolvedValue(undefined);
    io.list.mockResolvedValue([]);
    io.commit.mockResolvedValue(undefined);
    io.read.mockImplementation(async (id: string) =>
      sessionFile(id === first.id ? first : second),
    );
    io.remove.mockResolvedValue(undefined);
    io.workspaceGet.mockReturnValue(undefined);
    io.workspaceSet.mockResolvedValue(undefined);
    useChatStore.setState({
      sessionsHydrated: false,
      draftSessionId: null,
      sessions: [],
      activeSessionId: null,
      activeSessionRevision: 0,
      runLockSessionIds: {},
      sessionSyncError: null,
      refreshSessions: realRefreshSessions,
      commitMessages: realCommitMessages,
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

  it("restores the most recent session and persists it when no active id exists", async () => {
    io.list.mockResolvedValue([first, second]);

    await useChatStore.getState().hydrateSessions();

    expect(useChatStore.getState().activeSessionId).toBe(first.id);
    expect(io.read).toHaveBeenCalledWith(first.id);
    expect(io.workspaceSet).toHaveBeenCalledWith(
      "ai:activeSessionId",
      first.id,
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

  it("blocks new, switch, and delete while the active run lock is held", async () => {
    useChatStore.setState({
      sessions: [first, second],
      activeSessionId: first.id,
    });
    await useChatStore.getState().ensureSessionRunLock(first.id);

    expect(useChatStore.getState().newSession()).toBe(first.id);
    useChatStore.getState().switchSession(second.id);
    useChatStore.getState().deleteSession(second.id);

    expect(useChatStore.getState().activeSessionId).toBe(first.id);
    expect(useChatStore.getState().sessions).toHaveLength(2);
    expect(io.remove).not.toHaveBeenCalled();
  });

  it("keeps a new session as one unlisted draft until a user message is sent", () => {
    useChatStore.setState({ sessions: [first], activeSessionId: first.id });

    const draftId = useChatStore.getState().newSession();

    expect(useChatStore.getState().activeSessionId).toBe(draftId);
    expect(useChatStore.getState().draftSessionId).toBe(draftId);
    expect(useChatStore.getState().sessions).toEqual([first]);
    expect(useChatStore.getState().newSession()).toBe(draftId);
    expect(useChatStore.getState().sessions).toEqual([first]);

    useChatStore.getState().promoteSession(draftId, [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    ]);

    expect(useChatStore.getState().draftSessionId).toBeNull();
    expect(useChatStore.getState().sessions[0]).toMatchObject({
      id: draftId,
      title: "hello",
    });
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
    expect(refresh).not.toHaveBeenCalled();
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
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("allows a later send attempt after another process releases the lock", async () => {
    io.acquire.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await useChatStore.getState().ensureSessionRunLock(first.id)).toBe(
      false,
    );
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
    expect(await useChatStore.getState().ensureSessionRunLock(first.id)).toBe(
      true,
    );
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

  it("seeds the fallback session before deleting the active session", async () => {
    useChatStore.setState({
      sessions: [first, second],
      activeSessionId: first.id,
      runLockSessionIds: {},
    });

    useChatStore.getState().deleteSession(first.id);
    await vi.waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe(second.id);
    });

    expect(io.read).toHaveBeenCalledWith(second.id);
    expect(seedMessages.has(second.id)).toBe(true);
  });
});
