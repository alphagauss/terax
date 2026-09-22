import { describe, expect, it } from "vitest";
import type { ModelMessage, UIMessage } from "ai";
import {
  attachmentContextText,
  messageRawText,
  type MessageAttachment,
} from "@/modules/ai/lib/messageAttachments";
import {
  conversationEventPart,
  convertToAgentModelMessages,
  messageMetadata,
  projectConversationDisplay,
  projectSessionMessages,
  serializeSessionMessages,
} from "@/modules/ai/lib/conversation";

function modelText(messages: ModelMessage[]): string {
  return messages
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          ),
    )
    .join("");
}

describe("用户路径附件", () => {
  const attachment: MessageAttachment = {
    kind: "file",
    name: '示例".ts',
    size: 120,
    path: 'C:/workspace/示例".ts',
    environmentKey: "local",
  };
  const message: UIMessage = {
    id: "user",
    role: "user",
    parts: [{ type: "text", text: "检查这个文件" }],
    metadata: { attachments: [attachment] },
  };
  const selection: MessageAttachment = {
    kind: "selection",
    id: "selection",
    source: "editor",
    path: 'C:/workspace/a&".ts',
    text: "const selected = true;",
  };
  const snippet: MessageAttachment = {
    kind: "snippet",
    id: "review",
    handle: 'review"all',
    content: "Review all relevant files.",
  };

  it("以稳定 JSON 投影路径，不改写用户可见正文", () => {
    expect(attachmentContextText([attachment])).toBe(
      `<attached_files>\n${JSON.stringify([
        {
          path: attachment.path,
          name: attachment.name,
          size: attachment.size,
        },
      ])}\n</attached_files>`,
    );
    expect(messageRawText(message)).toBe("检查这个文件");
  });

  it("将编辑器选区及转义后的绝对路径投影到所属用户消息", () => {
    expect(attachmentContextText([selection])).toBe(
      '<selection source="editor" path="C:/workspace/a&amp;&quot;.ts">\nconst selected = true;\n</selection>',
    );
  });

  it("将片段内容投影到所属用户消息", () => {
    expect(attachmentContextText([snippet])).toBe(
      '<snippet name="review&quot;all">\nReview all relevant files.\n</snippet>',
    );
  });

  it.each([false, true])(
    "普通及引导消息恢复附件并生成相同模型输入：guided=%s",
    async (guided) => {
      const messageWithSelection: UIMessage = {
        ...message,
        metadata: { attachments: [attachment, selection, snippet] },
      };
      const messages: UIMessage[] = guided
        ? [
            {
              id: "assistant",
              role: "assistant",
              parts: [
                conversationEventPart({
                  event: "user_steering",
                  message: messageWithSelection,
                }),
              ],
            },
          ]
        : [messageWithSelection];
      const records = serializeSessionMessages(messages, {
        timestamp: "2026-09-11T00:00:00.000Z",
        turnId: "turn",
      });
      const restored = projectSessionMessages(
        "session",
        JSON.parse(JSON.stringify(records)),
      );
      const displayed = projectConversationDisplay(restored).find(
        (item) => item.role === "user",
      );
      if (!displayed) throw new Error("缺少恢复的用户消息");
      expect(messageMetadata(displayed).attachments).toEqual([
        attachment,
        selection,
        snippet,
      ]);
      expect(messageRawText(displayed)).toBe("检查这个文件");
      const before = await convertToAgentModelMessages(messages);
      expect(await convertToAgentModelMessages(restored)).toEqual(before);
      const text = modelText(before);
      expect(text).toContain(attachmentContextText([attachment]));
      expect(text).toContain(attachmentContextText([selection]));
      expect(text).toContain(attachmentContextText([snippet]));
      expect(text).toContain("检查这个文件");
      expect(text).not.toContain("environmentKey");
    },
  );

  it("附件本身构成有效的用户模型消息", async () => {
    const model = await convertToAgentModelMessages([
      { ...message, parts: [] },
    ]);
    expect(model).toHaveLength(1);
    expect(modelText(model)).toContain(attachmentContextText([attachment]));
  });
});
