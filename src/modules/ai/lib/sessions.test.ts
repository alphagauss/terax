/**
 * 本文件验证 AI 会话摘要 IPC、时间转换与多进程列表合并。
 * 测试锁定列表不携带检查 metadata，JSONL 边界使用 ISO 时间。
 */

import { describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));

import {
  canRevealSessionCwd,
  commitSession,
  listSessions,
  mergeSessionMetadata,
  resolveSessionCwd,
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
  cwd: `/workspace/${id}`,
  agentId: "builtin:main",
  agentName: "Terax",
  agentIcon: "coder",
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

describe("session working directory", () => {
  it("follows Explorer for a draft and keeps persisted sessions fixed", () => {
    const persisted = meta("saved", 1);
    expect(resolveSessionCwd("draft", "draft", [], "/workspace/one")).toBe(
      "/workspace/one",
    );
    expect(resolveSessionCwd("draft", "draft", [], "/workspace/two")).toBe(
      "/workspace/two",
    );
    expect(
      resolveSessionCwd("saved", "draft", [persisted], "/workspace/other"),
    ).toBe("/workspace/saved");
  });

  it("only enables navigation for persisted sessions in the current environment", () => {
    const persisted = meta("saved", 1);
    expect(canRevealSessionCwd("draft", "draft", [], "local")).toBe(false);
    expect(
      canRevealSessionCwd(
        "saved",
        null,
        [{ ...persisted, environmentKey: "wsl:Ubuntu" }],
        "local",
      ),
    ).toBe(false);
    expect(canRevealSessionCwd("saved", null, [persisted], "local")).toBe(true);
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
        cwd: "/workspace/session",
        agentId: "agent-review",
        agentName: "Reviewer",
        agentIcon: "reviewer",
        title: "Session",
        metadata: { systemPrompt: "must not enter the summary" },
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
        cwd: "/workspace/session",
        agentId: "agent-review",
        agentName: "Reviewer",
        agentIcon: "reviewer",
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
      cwd: "/workspace/session",
      agentId: "builtin:main",
      agentName: "Terax",
      agentIcon: "coder",
      title: "Session",
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
        cwd: "/workspace/session",
        metadata: { title: "Session" },
        messages: [],
      }),
    ).resolves.toMatchObject({ fingerprint: "1:2" });

    expect(ipc).toHaveBeenCalledWith("ai_session_commit", {
      session: {
        id: "session",
        createdAt: "2026-07-26T10:00:00.000Z",
        updatedAt: "2026-07-26T10:00:01.000Z",
        environmentKey: "local",
        cwd: "/workspace/session",
        metadata: { title: "Session" },
        messages: [],
      },
    });
  });
});
