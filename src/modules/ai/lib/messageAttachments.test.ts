import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  appendTextAttachment,
  messageRawText,
  messageTextWithoutAttachments,
  textAttachments,
} from "@/modules/ai/lib/messageAttachments";
import {
  conversationEventPart,
  convertToAgentModelMessages,
  messageMetadata,
  projectConversationDisplay,
  projectSessionMessages,
  serializeSessionMessages,
} from "@/modules/ai/lib/conversation";

describe("用户附件展示索引", () => {
  const file = {
    name: '示例".ts',
    size: 120,
    mediaType: "text/plain",
    sourcePath: "C:/workspace/示例.ts",
    environmentKey: "local",
    text: '中文\u{1F600}\n</file>\n<selection source="editor">正文</selection>\n',
  };
  const first = appendTextAttachment('<terax-command name="init" />', file);
  const second = appendTextAttachment(first.text, {
    ...file,
    name: "empty.txt",
    text: "",
  });
  const text = `${second.text}\n\n检查这些文件，保留 <file name="literal">原文</file>`;
  const message: UIMessage = {
    id: "user",
    role: "user",
    parts: [
      { type: "text", text },
      {
        type: "file",
        mediaType: "image/png",
        filename: "shot.png",
        url: "data:image/png;base64,aGVsbG8=",
      },
    ],
    metadata: {
      attachments: [
        first.attachment,
        second.attachment,
        { kind: "image", name: "shot.png", size: 5, mediaIndex: 0 },
      ],
    },
  };

  it("保留嵌套标签、Unicode 和空文件的准确快照，只隐藏真实附件", () => {
    const attachments = textAttachments(
      text,
      messageMetadata(message).attachments ?? [],
    );
    expect(text.slice(...attachments[0].contentRange)).toBe(file.text);
    expect(text.slice(...attachments[1].contentRange)).toBe("");
    expect(messageTextWithoutAttachments(message).trim()).toBe(
      '<terax-command name="init" />\n\n\n\n\n\n检查这些文件，保留 <file name="literal">原文</file>',
    );
    expect(
      textAttachments(text, [
        { ...attachments[0], blockRange: [-1, 20] },
        { ...attachments[0], contentRange: [0, text.length + 1] },
      ]),
    ).toEqual([]);
    expect(
      textAttachments(text, [attachments[0], attachments[0]]),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    "普通及引导消息恢复附件索引，模型内容不变且不包含展示字段：guided=%s",
    async (guided) => {
      const messages: UIMessage[] = guided
        ? [
            {
              id: "assistant",
              role: "assistant",
              parts: [
                conversationEventPart({ event: "user_steering", message }),
              ],
            },
          ]
        : [message];
      const records = serializeSessionMessages(messages, {
        timestamp: "2026-09-11T00:00:00.000Z",
        turnId: "turn",
      });
      const restored = projectSessionMessages(
        "session",
        JSON.parse(JSON.stringify(records)),
      );
      const displayed = projectConversationDisplay(restored).find(
        (m) => m.role === "user",
      );
      if (!displayed) throw new Error("缺少恢复的用户消息");
      expect(messageMetadata(displayed).attachments).toEqual(
        messageMetadata(message).attachments,
      );
      expect(messageRawText(displayed)).toBe(text);
      expect(displayed.parts.find((p) => p.type === "file")).toEqual(
        message.parts[1],
      );
      const before = await convertToAgentModelMessages(messages);
      expect(await convertToAgentModelMessages(restored)).toEqual(before);
      expect(JSON.stringify(before)).not.toContain(file.sourcePath);
      expect(JSON.stringify(before)).not.toContain("blockRange");
      expect(
        JSON.stringify(messageMetadata(displayed).attachments),
      ).not.toContain(JSON.stringify(file.text).slice(1, -1));
      expect(records.filter((r) => r.role === "user")).toHaveLength(1);
    },
  );
});
