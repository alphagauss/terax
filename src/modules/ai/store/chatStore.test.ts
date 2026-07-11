import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  list: vi.fn(),
  publish: vi.fn(),
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
  publishSession: io.publish,
  readSession: io.read,
  deleteSessionFile: io.remove,
}));

vi.mock("@/modules/workspace-process", () => ({
  getWorkspaceValue: io.workspaceGet,
  setWorkspaceValue: io.workspaceSet,
}));

vi.mock("../lib/modelPrefs", () => ({ pushRecentModel: vi.fn() }));

import type { UIMessage } from "@ai-sdk/react";
import {
  chats,
  seedMessages,
  useChatStore,
} from "./chatStore";
import type { SessionMeta } from "../lib/sessions";

const realRefreshSessions = useChatStore.getState().refreshSessions;

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

const snapshot = (meta: SessionMeta) => ({
  schemaVersion: 1 as const,
  id: meta.id,
  title: meta.title,
  createdAt: meta.createdAt,
  updatedAt: meta.updatedAt,
  messages: [] as UIMessage[],
  todos: [],
});

describe("chat store multi-process lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chats.clear();
    seedMessages.clear();
    io.acquire.mockResolvedValue(true);
    io.release.mockResolvedValue(undefined);
    io.list.mockResolvedValue([]);
    io.publish.mockResolvedValue(undefined);
    io.read.mockImplementation(async (id: string) =>
      snapshot(id === first.id ? first : second),
    );
    io.remove.mockResolvedValue(undefined);
    io.workspaceGet.mockReturnValue(undefined);
    io.workspaceSet.mockResolvedValue(undefined);
    useChatStore.setState({
      sessionsHydrated: false,
      sessions: [],
      activeSessionId: null,
      activeSessionRevision: 0,
      runLockSessionIds: {},
      sessionSyncError: null,
      refreshSessions: realRefreshSessions,
    });
  });

  it("restores the most recent snapshot and persists it when no active id exists", async () => {
    io.list.mockResolvedValue([first, second]);

    await useChatStore.getState().hydrateSessions();

    expect(useChatStore.getState().activeSessionId).toBe(first.id);
    expect(io.read).toHaveBeenCalledWith(first.id);
    expect(io.workspaceSet).toHaveBeenCalledWith(
      "ai:activeSessionId",
      first.id,
    );
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
      useChatStore.getState().publishMessages(first.id, [
        { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ]),
    ).rejects.toThrow("release failed");
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBe(true);
    expect(refresh).not.toHaveBeenCalled();

    await useChatStore.getState().publishMessages(first.id, [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ]);
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("allows a later send attempt after another process releases the lock", async () => {
    io.acquire.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await useChatStore.getState().ensureSessionRunLock(first.id)).toBe(false);
    expect(useChatStore.getState().runLockSessionIds[first.id]).toBeUndefined();
    expect(await useChatStore.getState().ensureSessionRunLock(first.id)).toBe(true);
  });

  it("evicts an inactive cached Chat when its disk fingerprint changes", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    chats.set(
      second.id,
      { stop, status: "ready", messages: [] } as never,
    );
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

  it("seeds the fallback snapshot before deleting the active session", async () => {
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
