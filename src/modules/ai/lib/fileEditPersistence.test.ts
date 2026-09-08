import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import {
  getFileEditRuntime,
  releaseFileEditRuntime,
} from "@/modules/ai/lib/fileEditRuntime";
import {
  convertToAgentModelMessages,
  materializeFileEditParts,
  messageMetadata,
  projectConversationDisplay,
  projectSessionMessages,
  type SessionMessage,
} from "@/modules/ai/lib/conversation";
import {
  persistCompletedTurn,
  persistTurnCheckpoint,
  type SessionCommitCursor,
} from "@/modules/ai/lib/sessionPersistence";

const commit = vi.hoisted(() => vi.fn());
vi.mock("@/modules/ai/lib/sessions", () => ({ commitSession: commit }));
const session = {
  id: "file-history",
  createdAt: 1,
  updatedAt: 2,
  environmentKey: "local",
  cwd: "/work",
  metadata: {},
  messages: [],
};
const message: UIMessage = {
  id: "assistant",
  role: "assistant",
  parts: [{ type: "text", text: "Done" }],
};
const file = (before: string, after: string) => ({
  path: "a.ts",
  identity: "/work/a.ts",
  before,
  after,
  isNewFile: false,
});
const cursor = (): SessionCommitCursor => ({
  persistedMessages: 0,
  committedParts: 0,
  turnId: "turn-1",
});

afterEach(() => {
  releaseFileEditRuntime(session.id);
  commit.mockReset();
});

describe("文件改动的保存与恢复", async () => {
  it("保存失败保留事实，取消终态等待已开始的原生编辑返回", async () => {
    const runtime = getFileEditRuntime(session.id);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    void runtime.track(async () => {
      await gate;
      await runtime.complete("edit", undefined, [file("before\n", "after\n")]);
    });
    commit.mockRejectedValueOnce(new Error("disk full"));
    const position = cursor();
    const saving = persistCompletedTurn(
      session,
      position,
      [message],
      "cancelled",
      [],
    );
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    finish();
    await expect(saving).rejects.toThrow("disk full");
    expect(position.persistedMessages).toBe(0);
    expect(runtime.pending().snapshot.calls).toHaveLength(1);
    commit.mockResolvedValue(undefined);
    await persistCompletedTurn(session, position, [message], "cancelled", []);
    const records = commit.mock.lastCall?.[0].messages as SessionMessage[];
    expect(records.find((record) => record.role === "assistant")).toMatchObject(
      { turn_status: "cancelled" },
    );
    expect(records.find((record) => record.role === "display")).toMatchObject({
      content: { files: [file("before\n", "after\n")] },
    });
    expect(runtime.pending().snapshot.calls).toEqual([]);
  });

  it("跨 checkpoint 还原净改动，展示事实不会进入模型；引导分段只在末段显示卡片", async () => {
    const runtime = getFileEditRuntime(session.id);
    const saved: SessionMessage[] = [];
    commit.mockImplementation(async (input) => {
      saved.push(...input.messages);
    });
    const position = cursor();
    const guidance: UIMessage = {
      id: "guide",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
    };
    await runtime.complete("root-edit", undefined, [
      file("secret baseline\n", "middle\n"),
    ]);
    await persistTurnCheckpoint(session, position, [message], {
      event: "user_steering",
      message: guidance,
    });
    await runtime.complete("child-edit", "child", [
      file("middle\n", "final snapshot\n"),
    ]);
    const completed: UIMessage = {
      ...message,
      parts: [
        ...message.parts,
        {
          type: "data-user-steering",
          data: { event: "user_steering", message: guidance },
        },
        { type: "text", text: "Final answer" },
      ],
    };
    await persistCompletedTurn(session, position, [completed], "completed", []);
    const history = projectSessionMessages(session.id, saved);
    const display = projectConversationDisplay(history);
    const assistants = display.filter((item) => item.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(
      assistants.map((item) => messageMetadata(item).fileEditsSummary),
    ).toEqual([false, true]);
    const edits = messageMetadata(assistants[1]).fileEdits;
    expect(edits?.files).toEqual([
      file("secret baseline\n", "final snapshot\n"),
    ]);
    expect(edits?.calls.map((call) => call.toolCallId)).toEqual([
      "root-edit",
      "child-edit",
    ]);
    const live = projectConversationDisplay(
      materializeFileEditParts([completed], runtime.snapshot(), "turn-1"),
    );
    expect(messageMetadata(live[live.length - 1]).fileEdits).toEqual(edits);
    const model = JSON.stringify(await convertToAgentModelMessages(history));
    expect(model).toContain("Final answer");
    expect(model).not.toContain("secret baseline");
    expect(model).not.toContain("final snapshot");
    expect(model).not.toContain("file-edits");
  });
});
