import { expect, it, vi } from "vitest";
import { channelInputText } from "@/modules/channels/messages";
import prompt from "@/modules/ai/prompts/channel";

vi.mock("@/i18n", () => ({
  default: { t: () => "收到附件本身不代表用户要求立即读取或解析。" },
}));

it("adds attachment guidance to each attachment input and retains the actual saved path", () => {
  const message = {
    id: "message",
    senderId: "sender",
    text: "",
    replyContext: "secret",
    receivedAt: 1,
    attachments: [
      {
        id: "attachment",
        name: "报告.pdf",
        kind: "file" as const,
        status: "ready" as const,
        path: "attachments/报告(1).pdf",
        size: 10,
      },
    ],
  };
  const text = channelInputText(message);
  expect(text).toContain("收到附件本身不代表用户要求立即读取或解析。");
  expect(text).toContain("attachments/报告(1).pdf");
  expect(text).not.toContain("secret");
  expect(channelInputText({ ...message, text: "hello", attachments: [] })).toBe(
    "hello",
  );
  expect(prompt).not.toContain("Receiving an attachment alone");
});
