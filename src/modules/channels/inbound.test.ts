import { materializeChannelInbound } from "@/modules/channels/inbound";
import { readPathAttachment } from "@/modules/ai/lib/attachmentFiles";
import { prepareChannelWorkspace } from "@/modules/channels/workspace";
import { expect, it, vi } from "vitest";

vi.mock("@/modules/ai/lib/attachmentFiles", () => ({
  readPathAttachment: vi.fn(),
}));
vi.mock("@/modules/channels/workspace", () => ({
  prepareChannelWorkspace: vi.fn(),
}));

it("materializes only ready images into reusable generic model media", async () => {
  vi.mocked(prepareChannelWorkspace).mockResolvedValue("C:/channel");
  vi.mocked(readPathAttachment)
    .mockResolvedValueOnce({
      kind: "image",
      mediaType: "image/jpeg",
      url: "data:image/jpeg;base64,AA==",
      size: 1,
    })
    .mockResolvedValueOnce({
      kind: "image",
      mediaType: "image/png",
      url: "data:image/png;base64,BB==",
      size: 2,
    });
  const connection = {
    id: "connection",
    sessionId: "session",
    kind: "weixin" as const,
    name: "WeChat",
    enabled: true,
    accountId: "owner",
    busyMessageMode: "queue" as const,
  };
  const input = {
    id: "message",
    senderId: "owner",
    text: "look",
    receivedAt: 1,
    replyContext: "secret",
    attachments: [
      {
        id: "jpg",
        name: "one.jpg",
        kind: "image" as const,
        status: "ready" as const,
        path: "attachments/one.jpg",
        size: 1,
      },
      {
        id: "pdf",
        name: "report.pdf",
        kind: "file" as const,
        status: "ready" as const,
        path: "attachments/report.pdf",
        size: 2,
      },
      {
        id: "missing",
        name: "gone.png",
        kind: "image" as const,
        status: "failed" as const,
      },
      {
        id: "png",
        name: "two.png",
        kind: "image" as const,
        status: "ready" as const,
        path: "attachments/two.png",
        size: 3,
      },
    ],
  };

  const result = await materializeChannelInbound(
    connection,
    input,
    new AbortController().signal,
  );

  expect(readPathAttachment).toHaveBeenNthCalledWith(
    1,
    "C:/channel/attachments/one.jpg",
    { kind: "local" },
    { image: true },
  );
  expect(readPathAttachment).toHaveBeenNthCalledWith(
    2,
    "C:/channel/attachments/two.png",
    { kind: "local" },
    { image: true },
  );
  expect(result.modelMedia).toEqual([
    {
      type: "file",
      mediaType: "image/jpeg",
      url: "data:image/jpeg;base64,AA==",
      filename: "one.jpg",
    },
    {
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,BB==",
      filename: "two.png",
    },
  ]);
});
