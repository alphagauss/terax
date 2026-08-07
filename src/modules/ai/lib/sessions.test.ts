/**
 * 本文件验证 AI 会话 IPC 的时间转换与多进程 metadata 合并。
 * 测试锁定 JSONL 边界使用 ISO 时间，前端状态继续使用毫秒值。
 */

import { describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));

import {
  commitSession,
  listSessions,
  mergeSessionMetadata,
  type SessionMeta,
} from "./sessions";

const meta = (
  id: string,
  updatedAt: number,
  fingerprint?: string,
): SessionMeta => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt,
  environmentKey: "local",
  metadata: { title: id, todos: [] },
  fingerprint,
});

describe("session metadata merge", () => {
  it("accepts external additions, updates, and deletions", () => {
    const local = [meta("updated", 2, "old"), meta("deleted", 1, "old")];
    const disk = [meta("added", 4, "new"), meta("updated", 3, "new")];
    expect(mergeSessionMetadata(local, disk, new Set())).toEqual(disk);
  });

  it("preserves a running session and an unpublished New chat", () => {
    const local = [meta("running", 5, "old"), meta("draft", 4)];
    const disk = [meta("running", 6, "external"), meta("other", 3, "new")];
    expect(
      mergeSessionMetadata(local, disk, new Set(["running"])).map((session) => [
        session.id,
        session.fingerprint,
      ]),
    ).toEqual([
      ["running", "old"],
      ["draft", undefined],
      ["other", "new"],
    ]);
  });
});

describe("session IPC timestamp boundary", () => {
  it("converts ISO metadata timestamps to frontend milliseconds", async () => {
    ipc.mockResolvedValueOnce([
      {
        id: "session",
        createdAt: "2026-07-26T10:00:00.000Z",
        updatedAt: "2026-07-26T10:00:01.000Z",
        environmentKey: "local",
        metadata: { title: "Session", todos: [] },
        modifiedAt: 1,
        size: 2,
        fingerprint: "1:2",
      },
    ]);

    await expect(listSessions()).resolves.toEqual([
      {
        id: "session",
        title: "Session",
        createdAt: Date.parse("2026-07-26T10:00:00.000Z"),
        updatedAt: Date.parse("2026-07-26T10:00:01.000Z"),
        environmentKey: "local",
        metadata: { title: "Session", todos: [] },
        modifiedAt: 1,
        size: 2,
        fingerprint: "1:2",
      },
    ]);
  });

  it("commits frontend timestamps as ISO strings", async () => {
    ipc.mockResolvedValueOnce({
      id: "session",
      createdAt: "2026-07-26T10:00:00.000Z",
      updatedAt: "2026-07-26T10:00:01.000Z",
      environmentKey: "local",
      metadata: { title: "Session", todos: [] },
      modifiedAt: 1,
      size: 2,
      fingerprint: "1:2",
    });
    await expect(
      commitSession({
        id: "session",
        createdAt: Date.parse("2026-07-26T10:00:00.000Z"),
        updatedAt: Date.parse("2026-07-26T10:00:01.000Z"),
        environmentKey: "local",
        metadata: { title: "Session", todos: [] },
        messages: [],
      }),
    ).resolves.toMatchObject({ fingerprint: "1:2" });

    expect(ipc).toHaveBeenCalledWith("ai_session_commit", {
      session: {
        id: "session",
        createdAt: "2026-07-26T10:00:00.000Z",
        updatedAt: "2026-07-26T10:00:01.000Z",
        environmentKey: "local",
        metadata: { title: "Session", todos: [] },
        messages: [],
      },
    });
  });
});
