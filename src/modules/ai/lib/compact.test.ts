import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { compactModelMessagesDetailed, estimateMessageTokens } from "./compact";

const BIG = "x".repeat(2000);

function readCall(id: string, path: string): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "read_file",
        input: { path },
      },
    ],
  } as unknown as ModelMessage;
}

function readResult(id: string, value: string): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: id, output: { type: "text", value } },
    ],
  } as unknown as ModelMessage;
}

function outputOf(message: ModelMessage): { __elided?: boolean } {
  const parts = message.content as Array<{ output?: { __elided?: boolean } }>;
  return parts[0].output ?? {};
}

function isElided(message: ModelMessage): boolean {
  return outputOf(message).__elided === true;
}

describe("compactModelMessagesDetailed", () => {
  it("does not count media encoding as text tokens", () => {
    const image = (data: string): ModelMessage[] => [
      {
        role: "user",
        content: [
          { type: "text", text: "中文" },
          { type: "image", image: data },
        ],
      },
    ];
    expect(estimateMessageTokens(image("a"))).toBe(
      estimateMessageTokens(image("a".repeat(100000))),
    );
  });

  it("preserves system instructions and complete current tool pairs when dropping old turns", () => {
    const system: ModelMessage = { role: "system", content: "永久指令" };
    const current: ModelMessage[] = [
      { role: "user", content: "当前问题" },
      readCall("new", "/new"),
      readResult("new", "小结果"),
    ];
    const result = compactModelMessagesDetailed(
      [
        system,
        { role: "user", content: BIG.repeat(5) },
        { role: "assistant", content: "旧回答" },
        ...current,
      ],
      1500,
    );
    expect(result.messages).toEqual([system, ...current]);
  });

  it("returns the input untouched when it fits the context budget", () => {
    const messages = [{ role: "user", content: "hi" }] as ModelMessage[];
    const result = compactModelMessagesDetailed(messages, 6000);
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("elides older tool results only over budget and preserves recent reads even after writes", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "检查文件" },
      readCall("c1", "/a.txt"),
      readResult("c1", BIG.repeat(3)),
      { role: "assistant", content: "已检查" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "write",
            toolName: "write_file",
            input: { path: "/a.txt" },
          },
        ],
      },
      readResult("write", "written"),
      readCall("c2", "/a.txt"),
      readResult("c2", "最新内容"),
    ];
    expect(compactModelMessagesDetailed(messages, 10000).messages).toBe(
      messages,
    );
    const once = compactModelMessagesDetailed(messages, 4000);
    expect(isElided(once.messages[2])).toBe(true);
    expect(once.messages.slice(-4)).toEqual(messages.slice(-4));
    expect(messages[2]).toEqual(readResult("c1", BIG.repeat(3)));
    const twice = compactModelMessagesDetailed(once.messages, 4000);
    expect(twice.compacted).toBe(false);
    expect(twice.messages).toBe(once.messages);
  });
});
