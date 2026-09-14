import { expect, it, vi } from "vitest";
import {
  channelInputText,
  channelUserMessage,
} from "@/modules/channels/messages";
import prompt from "@/modules/ai/prompts/channel";

vi.mock("@/i18n", () => ({
  default: {
    t: (key: string, values?: Record<string, unknown>) =>
      key === "channels:imageAttachmentSummary"
        ? `images=${values?.count}; paths=${values?.paths}`
        : "收到附件本身不代表用户要求立即读取或解析。",
  },
}));

it("adds attachment guidance to each attachment input and retains the actual saved path", () => {
  const message = {
    id: "message",
    senderId: "sender",
    text: "",
    target: { kind: "direct" as const, id: "owner" },
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
  expect(
    channelInputText({
      ...message,
      target: { kind: "group", id: "room" },
      text: "hello",
      attachments: [],
    }),
  ).toBe('[Sender: "sender"]\nhello');
  expect(prompt).not.toContain("Receiving an attachment alone");
});

it("uses one image summary and ordered generic file parts for a media batch", () => {
  const message = {
    id: "batch",
    senderId: "sender",
    text: "compare these",
    target: { kind: "direct" as const, id: "owner" },
    receivedAt: 42,
    attachments: [
      {
        id: "first",
        name: "first.jpg",
        kind: "image" as const,
        status: "ready" as const,
        path: "attachments/first.jpg",
        size: 1,
      },
      {
        id: "report",
        name: "report.pdf",
        kind: "file" as const,
        status: "ready" as const,
        path: "attachments/report.pdf",
        size: 2,
      },
      {
        id: "second",
        name: "second.png",
        kind: "image" as const,
        status: "ready" as const,
        path: "attachments/second.png",
        size: 3,
      },
    ],
    modelMedia: [
      {
        type: "file" as const,
        mediaType: "image/jpeg",
        url: "data:image/jpeg;base64,AA==",
        filename: "first.jpg",
      },
      {
        type: "file" as const,
        mediaType: "image/png",
        url: "data:image/png;base64,BB==",
        filename: "second.png",
      },
    ],
  };

  const projected = channelUserMessage(message);

  expect(projected.parts).toEqual([
    expect.objectContaining({
      type: "text",
      text: expect.stringContaining("images=2"),
    }),
    {
      type: "file",
      mediaType: "image/jpeg",
      url: "data:image/jpeg;base64,AA==",
      filename: "first.jpg",
    },
    {
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,BB==",
      filename: "second.png",
    },
  ]);
  expect(channelInputText(message)).toContain("attachments/report.pdf");
  expect(channelInputText(message)).not.toContain('"attachments"');
});
