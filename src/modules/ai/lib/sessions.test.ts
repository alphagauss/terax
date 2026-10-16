/**
 * 本文件验证 AI 会话摘要 IPC、时间转换与多进程列表合并。
 * 测试锁定列表不携带检查 metadata，JSONL 边界使用 ISO 时间。
 */

import { describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));

import {
  canRevealSessionCwd,
  clearSessionProcesses,
  commitSession,
  deriveTitle,
  listSessions,
  mergeSessionMetadata,
  resolveSessionCwd,
  type SessionMeta,
} from "./sessions";

it("等待工具收尾后释放文件状态，即使进程终止失败也不提前返回", async () => {
  ipc.mockReset();
  ipc.mockImplementation(async (command) => {
    if (command === "shell_clear_owner") throw new Error("cleanup failed");
  });
  let finish!: () => void;
  const tools = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const cleanup = clearSessionProcesses("session", tools);
  await Promise.resolve();
  expect(ipc).not.toHaveBeenCalledWith(
    "agent_file_clear_owner",
    expect.anything(),
  );
  finish();
  await expect(cleanup).rejects.toThrow("cleanup failed");
  expect(ipc).toHaveBeenCalledWith("agent_file_clear_owner", {
    ownerSessionId: "session",
  });
  ipc.mockReset();
});

it("普通停止使用活跃执行范围，显式清理使用完整聊天范围", async () => {
  ipc.mockReset();
  await clearSessionProcesses("session", Promise.resolve(), "active");
  expect(ipc).toHaveBeenCalledWith("shell_stop_active", { ownerSessionId: "session" });
  expect(ipc).not.toHaveBeenCalledWith("shell_clear_owner", expect.anything());
  ipc.mockClear();
  await clearSessionProcesses("session");
  expect(ipc).toHaveBeenCalledWith("shell_clear_owner", { ownerSessionId: "session" });
});

it("从真实用户正文生成标题，不读取结构化片段", () => {
  expect(
    deriveTitle([
      {
        id: "user",
        role: "user",
        parts: [{ type: "text", text: "Review this" }],
        metadata: {
          attachments: [
            {
              kind: "snippet",
              id: "review",
              handle: "review",
              content: "internal context",
            },
          ],
        },
      },
    ]),
  ).toBe("Review this");
});

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
  it("草稿目录覆盖不影响新草稿或已保存会话", () => {
    const override = { sessionId: "draft", cwd: "/default/workspace" };
    expect(
      resolveSessionCwd("draft", "draft", [], "/project/other", override),
    ).toBe(override.cwd);
    expect(
      resolveSessionCwd("new", "new", [], "/project/other", override),
    ).toBe("/project/other");
    expect(
      resolveSessionCwd(
        "draft",
        "draft",
        [meta("draft", 1)],
        "/project/other",
        override,
      ),
    ).toBe("/workspace/draft");
  });
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

  it("enables navigation for the current draft and persisted sessions in the current environment", () => {
    const persisted = meta("saved", 1);
    expect(canRevealSessionCwd("draft", "draft", [], "local")).toBe(true);
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
