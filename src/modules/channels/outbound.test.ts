import { channelOwnerId } from "@/modules/channels/identity";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  projectDeliveries,
  hasDeliveryIssue,
  applyDeliveryRecord,
  useDeliveryHistory,
} from "@/modules/channels/history";
import {
  beginChannelSend,
  dismissChannelDeliveries,
  retryChannelDelivery,
} from "@/modules/channels/outbound";
import { readSession, type SessionFile } from "@/modules/ai/lib/sessions";
import { appendSessionDisplay } from "@/modules/ai/store/chatStore";
import type { ChannelSession } from "@/modules/channels/types";

vi.mock("@/modules/channels/agentSession", () => ({
  ensureChannelSession: vi.fn(),
}));
vi.mock("@/modules/ai/lib/sessions", () => ({ readSession: vi.fn() }));
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
beforeEach(() => {
  vi.resetAllMocks();
  useDeliveryHistory.setState({ sessions: {}, pending: {} });
});
describe("application Channel send", () => {
  function history() {
    const records: Parameters<typeof appendSessionDisplay>[1][] = [];
    vi.mocked(appendSessionDisplay).mockImplementation(async (id, record) => {
      records.push(structuredClone(record));
      if (record.role === "delivery") applyDeliveryRecord(id, record);
    });
    vi.mocked(readSession).mockImplementation(async (id) => {
      expect(id).toBe(connection.sessionId);
      return { messages: structuredClone(records) } as SessionFile;
    });
    return records;
  }

  it("忽略仅更新指定通知，保留发送事实，实时和重启后的汇总一致", async () => {
    const records = history();
    const result = {
      status: "failed" as const,
      parts: [],
      reason: "upload" as const,
    };
    const send = vi.fn(async () => result);
    await (await beginChannelSend(connection, { text: "first" }, send))
      .completed;
    await (await beginChannelSend(connection, { text: "later" }, send))
      .completed;
    const first = projectDeliveries(records)[0];
    await dismissChannelDeliveries(connection, [first.id, "unrelated"]);
    const restored = projectDeliveries(records);
    expect(restored[0]).toMatchObject({
      result,
      notification: { status: "ignored" },
    });
    expect(restored.filter((entry) => hasDeliveryIssue(entry))).toHaveLength(1);
    expect(useDeliveryHistory.getState().sessions.session).toEqual(restored);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("重发以新请求原子处理旧通知，失败归属新卡片且拒绝重复重发旧记录", async () => {
    const records = history();
    const content = {
      text: "/help",
      attachments: [{ path: "/file", presentation: "file" as const }],
    };
    const send = vi.fn(async () => ({ status: "unknown" as const, parts: [] }));
    await (await beginChannelSend(connection, content, send, "agent"))
      .completed;
    const original = projectDeliveries(records)[0];
    const resend = vi.fn(async () => ({
      status: "failed" as const,
      parts: [],
    }));
    await (await retryChannelDelivery(connection, original.id, resend))
      .completed;
    const restored = projectDeliveries(records);
    expect(restored).toHaveLength(2);
    expect(restored[0]).toMatchObject({
      result: original.result,
      notification: { status: "retried", retryId: restored[1].id },
    });
    expect(restored[1]).toMatchObject({
      retryOf: original.id,
      content,
      source: "application",
      notification: { status: "error" },
    });
    expect(resend).toHaveBeenCalledWith(content, restored[1].id);
    expect(restored.filter((entry) => hasDeliveryIssue(entry))).toEqual([
      restored[1],
    ]);
    expect(useDeliveryHistory.getState().sessions.session).toEqual(restored);
    await expect(
      retryChannelDelivery(connection, original.id, resend),
    ).rejects.toThrow("configuration");
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it("新请求保存失败保留旧问题且不发送，发送中的记录不能忽略或重发", async () => {
    const records = history();
    await (
      await beginChannelSend(connection, { text: "hello" }, async () => ({
        status: "failed",
        parts: [],
      }))
    ).completed;
    const original = projectDeliveries(records)[0];
    const resend = vi.fn();
    useDeliveryHistory.setState({ pending: { [original.id]: true } });
    await dismissChannelDeliveries(connection, [original.id]);
    await expect(
      retryChannelDelivery(connection, original.id, resend),
    ).rejects.toThrow();
    useDeliveryHistory.setState({ pending: {} });
    vi.mocked(appendSessionDisplay).mockRejectedValueOnce(
      new Error("disk full"),
    );
    await expect(
      retryChannelDelivery(connection, original.id, resend),
    ).rejects.toThrow("disk full");
    expect(projectDeliveries(records)).toEqual([original]);
    expect(resend).not.toHaveBeenCalled();
  });
  it.each(["application", "agent", "command", "tool"] as const)(
    "%s 保存通用投递结果，历史可恢复原因且不重发",
    async (source) => {
      const records: Parameters<typeof appendSessionDisplay>[1][] = [];
      vi.mocked(appendSessionDisplay).mockImplementation(
        async (_id, record) => {
          records.push(record);
        },
      );
      const result = {
        status: "unknown" as const,
        parts: [{ index: 0, status: "unknown" as const }],
        reason: "network" as const,
        total: 1,
      };
      const send = vi.fn(async () => result);
      expect(
        await (
          await beginChannelSend(connection, { text: "hello" }, send, source)
        ).completed,
      ).toEqual(result);
      expect(projectDeliveries(records)).toMatchObject([{ source, result }]);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
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
          source: "application",
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
