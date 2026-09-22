import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { planCompaction, type CompactionEvent } from "@/modules/ai/lib/compact";
import {
  convertToAgentModelMessages,
  conversationEventPart,
  expandConversationMessages,
  messageMetadata,
  projectSessionMessages,
  serializeSessionMessages,
} from "@/modules/ai/lib/conversation";

const user = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
});
const answer = (id: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [
    { type: "step-start" },
    { type: "reasoning", text: `thinking-${id}` },
    {
      type: "tool-read_file",
      toolCallId: id,
      state: "output-available",
      input: { path: "a.ts" },
      output: `code-${id}`,
    },
    { type: "step-start" },
    { type: "text", text: `final-${id}` },
  ],
});
const checkpoint = (
  id: string,
  throughUserMessageId: string,
): CompactionEvent => ({
  event: "compaction",
  id,
  throughUserMessageId,
  summary: `handoff-${id}`,
});
const event = (value: CompactionEvent): UIMessage => ({
  id: `event-${value.id}`,
  role: "assistant",
  parts: [conversationEventPart(value)],
});

describe("compaction checkpoints", () => {
  it("keeps original history, removes covered attachments/process only, and replays multiple summaries identically", async () => {
    const first = user("u1");
    first.parts = [
      { type: "text", text: "request" },
      {
        type: "file",
        mediaType: "image/png",
        url: "data:image/png;base64,YQ==",
      },
    ];
    first.metadata = {
      attachments: [
        {
          kind: "file",
          name: "a.txt",
          size: 4,
          path: "/work/a.txt",
          environmentKey: "local",
        },
        {
          kind: "selection",
          id: "selection",
          source: "editor",
          path: "/work/a.txt",
          text: "selected secret",
        },
        {
          kind: "snippet",
          id: "review",
          handle: "review",
          content: "snippet secret",
        },
        { kind: "image", name: "image", size: 1, mediaIndex: 0 },
      ],
    };
    const original = [first, answer("a1"), user("u2"), answer("a2")];
    const snapshot = structuredClone(original);
    const plan = planCompaction(expandConversationMessages(original), true);
    expect(plan?.throughUserMessageId).toBe("u1");
    const firstPass = [...original, event(checkpoint("c1", "u1"))];
    const context = JSON.stringify(
      await convertToAgentModelMessages(firstPass),
    );
    expect(context).not.toContain("/work/a.txt");
    expect(context).not.toContain("selected secret");
    expect(context).not.toContain("snippet secret");
    expect(context).not.toContain("image/png");
    expect(context).not.toContain("code-a1");
    expect(context).toContain("final-a1");
    expect(context).toContain("code-a2");
    expect(
      planCompaction(expandConversationMessages(firstPass), true),
    ).toBeNull();
    // 第二轮原先在摘要之前受到保护，下一次仍须压缩它。
    const secondPass = [...firstPass, user("u3"), answer("a3")];
    expect(
      planCompaction(expandConversationMessages(secondPass), true)
        ?.throughUserMessageId,
    ).toBe("u2");
    secondPass.push(event(checkpoint("c2", "u2")));
    const model = await convertToAgentModelMessages(secondPass);
    const text = JSON.stringify(model);
    expect(text).toContain("handoff-c1");
    expect(text).toContain("handoff-c2");
    expect(text).not.toContain("code-a2");
    expect(text).toContain("code-a3");
    const records = secondPass.flatMap((message, index) =>
      serializeSessionMessages([message], {
        timestamp: "2026-09-19T00:00:00Z",
        turnId: `turn-${index}`,
      }),
    );
    expect(
      await convertToAgentModelMessages(projectSessionMessages("s", records)),
    ).toEqual(model);
    expect(original).toEqual(snapshot);
    expect(JSON.stringify(records)).toContain("/work/a.txt");
  });

  it("protects the entire active turn including guidance and produces no checkpoint for plain conversation", () => {
    const guide = { ...user("guide"), metadata: { guided: true } };
    const messages = [
      user("u1"),
      answer("a1"),
      user("u2"),
      answer("a2"),
      guide,
      answer("a3"),
    ];
    expect(planCompaction(messages, true)?.throughUserMessageId).toBe("u1");
    expect(
      planCompaction(
        [
          user("u"),
          {
            id: "a",
            role: "assistant",
            parts: [{ type: "text", text: "answer" }],
          },
        ],
        false,
      ),
    ).toBeNull();
  });

  it("does not summarize changes to plain user text part structure", () => {
    const message: UIMessage = {
      id: "multipart",
      role: "user",
      parts: [
        { type: "text", text: "first", state: "done" },
        { type: "text", text: "second" },
      ],
    };
    expect(planCompaction([message], false)).toBeNull();
  });

  it("removes an attachment-only model message while retaining the stored fact", async () => {
    const message: UIMessage = {
      id: "attachment-only",
      role: "user",
      parts: [],
      metadata: {
        attachments: [
          {
            kind: "selection",
            id: "terminal-selection",
            source: "terminal",
            text: "terminal output",
          },
        ],
      },
    };
    expect(planCompaction([message], false)?.throughUserMessageId).toBe(
      message.id,
    );
    const compacted = [message, event(checkpoint("only", message.id))];
    expect(
      JSON.stringify(await convertToAgentModelMessages(compacted)),
    ).not.toContain("terminal output");
    expect(messageMetadata(message).attachments).toHaveLength(1);
  });
});
