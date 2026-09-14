import { channelOwnerId } from "@/modules/channels/identity";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { beginChannelSend } from "@/modules/channels/outbound";
import { appendSessionDisplay } from "@/modules/ai/store/chatStore";
import type { ChannelSession } from "@/modules/channels/types";

vi.mock("@/modules/channels/agentSession", () => ({
  ensureChannelSession: vi.fn(),
}));
vi.mock("@/modules/ai/store/chatStore", () => ({
  appendSessionDisplay: vi.fn(),
  seedSession: vi.fn(),
  chats: new Map(),
  seedMessages: new Map(),
}));
const connection: ChannelSession = {
  id: "channel",
  sessionId: "session",
  target: { kind: "direct" as const, id: "owner" },
  kind: "weixin",
  name: "test",
  enabled: true,
  accountId: "owner",
  busyMessageMode: "queue",
};
beforeEach(() => vi.resetAllMocks());
describe("application Channel send", () => {
  it.each(["request", "result"])("%s 保存失败不重跑投递", async (phase) => {
    const send = vi.fn(async () => ({
      status: "partial" as const,
      parts: [
        { index: 0, status: "accepted" as const },
        { index: 1, status: "failed" as const },
      ],
    }));
    vi.mocked(appendSessionDisplay).mockImplementation(async (_id, record) => {
      expect(send).toHaveBeenCalledTimes(
        record.content.phase === "request" ? 0 : 1,
      );
      if (record.content.phase === phase) throw new Error("disk full");
    });
    const request = beginChannelSend(
      connection,
      { text: "/help", attachments: [{ path: "/file", presentation: "file" }] },
      send,
    );
    if (phase === "request") await expect(request).rejects.toThrow("disk full");
    else await expect((await request).completed).rejects.toThrow("disk full");
    expect(send).toHaveBeenCalledTimes(phase === "request" ? 0 : 1);
    expect(appendSessionDisplay).toHaveBeenCalledWith(
      "session",
      expect.objectContaining({
        role: "delivery",
        content: expect.objectContaining({
          phase: "request",
          target: connection.target,
          content: {
            text: "/help",
            attachments: [{ path: "/file", presentation: "file" }],
          },
        }),
      }),
      await channelOwnerId(connection),
    );
  });
});
