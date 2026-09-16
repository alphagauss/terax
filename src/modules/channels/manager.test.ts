/**
 * 本文件验证多连接的隔离、轮次串行与接收检查点。
 * 重连不重跑已接受消息，改名保留在途任务，停止一个连接不会取消另一个连接的接收。
 */

import { TurnInbox } from "@/modules/ai/lib/turnInbox";
import { ChannelManager } from "@/modules/channels/manager";
import { ChannelError } from "@/modules/channels/types";
import type {
  ChannelCheckpoint,
  ChannelConnection,
  ChannelInbound,
  ChannelSnapshot,
  ReceiveContext,
} from "@/modules/channels/types";
import { assert, describe, expect, it, vi } from "vitest";
import { getChannelMessageSender } from "@/modules/channels/delivery";

const connection = (id: string): ChannelConnection => ({
  id,

  kind: "weixin",
  name: id,
  enabled: true,
  accountId: id,
  busyMessageMode: "queue",
});
const message = (id: string): ChannelInbound => ({
  id,
  text: id,
  senderId: id,
  attachments: [],
  target: { kind: "direct" as const, id: "owner" },
  receivedAt: 1,
});

function identity(id: string) {
  return JSON.stringify([JSON.stringify(["direct", "owner", null]), id]);
}

function harness(
  command?: (
    connection: ChannelConnection,
    message: ChannelInbound,
    signal: AbortSignal,
  ) => Promise<string | null>,
) {
  let cancelled = false;
  const cancelledSessions = new Set<string>();
  const inboxes = new Map<string, TurnInbox>();
  const receivers = new Map<string, ReceiveContext>();
  const disk = new Map<string, ChannelCheckpoint>();
  const gates: Array<() => void> = [];
  const calls: string[] = [];
  let snapshots: ChannelSnapshot[] = [];
  const send = vi.fn(async () => ({
    status: "accepted" as const,
    parts: [{ index: 0, status: "accepted" as const }],
  }));
  const save = vi.fn(
    async (connection: ChannelConnection, checkpoint: ChannelCheckpoint) => {
      disk.set(connection.id, structuredClone(checkpoint));
    },
  );
  const manager = new ChannelManager({
    deliver: (_connection, _content, send) => send(),
    command,
    adapter: async (connection) => ({
      canSend: () => true,
      cursorScope: connection.accountId ?? "",
      receive: async (context) => {
        receivers.set(connection.id, context);
        context.status("online");
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      },
      send,
    }),
    load: async (connection) =>
      structuredClone(
        disk.get(connection.id) ?? {
          conversations: [],
          cursor: "",
          cursorScope: "",
          recentIds: [],
          pendingIds: [],
        },
      ),
    save,
    run: async (connection, input, signal, ready) => {
      const inbox = new TurnInbox();
      inbox.open();
      inboxes.set(connection.id, inbox);
      ready((message) =>
        inbox.steer({
          id: message.id,
          role: "user",
          parts: [{ type: "text", text: message.text }],
        }),
      );
      calls.push(`${connection.id}:${input.id}`);
      await new Promise<void>((resolve) => {
        gates.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      signal.throwIfAborted();
      inbox.close();
      if (cancelled || cancelledSessions.has(connection.sessionId)) {
        inbox.cancel();
        return null;
      }
      let entry = inbox.take();
      while (entry) {
        entry.settle("consumed");
        entry = inbox.take();
      }
      return input.text;
    },
    failureText: () => "Failed",
    emptyReply: () => "Empty",
    changed: (value) => {
      snapshots = value;
    },
  });
  return {
    manager,
    inboxes,
    cancel: (sessionId?: string) => {
      if (sessionId) cancelledSessions.add(sessionId);
      else cancelled = true;
    },
    receivers,
    disk,
    gates,
    calls,
    send,
    save,
    snapshots: () => snapshots,
  };
}

describe("ChannelManager", () => {
  it("即时命令在任务期间独立回复原消息，不引导模型且不混入最终回复身份", async () => {
    const command = vi.fn(
      async (_connection: ChannelConnection, input: ChannelInbound) =>
        input.text === "/h" ? "Help" : null,
    );
    const h = harness(command);
    await h.manager.configure([
      { ...connection("a"), busyMessageMode: "steer" },
    ]);
    await vi.waitFor(() => expect(h.receivers.has("a")).toBe(true));
    await h.receivers.get("a")?.receive(message("task"));
    h.send.mockResolvedValueOnce({ status: "failed" as never, parts: [] });
    await h.receivers.get("a")?.receive({
      ...message("help"),
      target: { kind: "direct", id: "owner" },
      text: "/h",
    });
    expect(h.calls).toEqual(["a:task"]);
    expect(h.inboxes.get("a")?.hasPending).toBe(false);
    expect(h.send).toHaveBeenCalledWith(
      { kind: "direct", id: "owner" },
      { text: "Help" },
      expect.any(AbortSignal),
    );
    expect(h.disk.get("a")?.pendingIds).toEqual([identity("task")]);
    expect(h.snapshots()[0]).toMatchObject({
      status: "online",
      issue: "delivery",
    });
    h.gates[0]();
    await vi.waitFor(() => expect(h.snapshots()[0].busy).toBe(false));
    expect(h.send).toHaveBeenLastCalledWith(
      { kind: "direct", id: "owner" },
      { text: "task" },
      expect.any(AbortSignal),
    );
    expect(h.snapshots()[0].issue).toBeNull();
    await h.manager.dispose();
  });

  it("同实例不同对话和话题独立运行，取消不清空其他对话，重启复用绑定", async () => {
    const h = harness();
    await h.manager.configure([connection("a")]);
    await vi.waitFor(() => expect(h.receivers.has("a")).toBe(true));
    const receiver = h.receivers.get("a");
    assert(receiver);
    const receive = receiver.receive;
    const group = { kind: "group" as const, id: "room" };
    const topic = { ...group, threadId: "topic" };
    await Promise.all([
      receive({ ...message("same"), target: group, senderId: "alice" }),
      receive({ ...message("same"), target: group, senderId: "alice" }),
    ]);
    await receive({ ...message("same"), target: topic, senderId: "bob" });
    const bindings = h.snapshots()[0].conversations;
    expect(bindings).toHaveLength(2);
    expect(new Set(bindings.map((item) => item.sessionId)).size).toBe(2);
    expect(bindings.every((item) => item.busy)).toBe(true);
    expect(h.calls).toHaveLength(2);
    expect(h.disk.get("a")?.pendingIds).toHaveLength(2);
    await receive({ ...message("queued-a"), target: group, senderId: "bob" });
    await receive({ ...message("queued-b"), target: topic, senderId: "alice" });
    h.cancel(bindings[0].sessionId);
    h.gates[0]();
    await vi.waitFor(() =>
      expect(h.snapshots()[0].conversations[0].busy).toBe(false),
    );
    expect(h.snapshots()[0].conversations[1]).toMatchObject({
      busy: true,
      queued: 1,
    });
    expect(h.disk.get("a")?.pendingIds).toHaveLength(2);
    h.gates[1]();
    await vi.waitFor(() => expect(h.gates).toHaveLength(3));
    h.gates[2]();
    await vi.waitFor(() => expect(h.snapshots()[0].busy).toBe(false));
    expect(h.calls).toEqual(["a:same", "a:same", "a:queued-b"]);
    await h.manager.dispose();
    h.receivers.clear();
    await h.manager.configure([{ ...connection("a"), enabled: false }]);
    await vi.waitFor(() =>
      expect(h.snapshots()[0].conversations).toHaveLength(2),
    );
    expect(
      h.snapshots()[0].conversations.map((item) => item.sessionId),
    ).toEqual(bindings.map((item) => item.sessionId));
    expect(h.snapshots()[0].conversations.every((item) => !item.canSend)).toBe(
      true,
    );
    expect(h.receivers.size).toBe(0);
    await h.manager.dispose();
  });

  it("一个对话的命令保存失败不停止其他对话或连接接收", async () => {
    const h = harness(async (_connection, message) => {
      if (message.text === "/h") throw new ChannelError("storage");
      return null;
    });
    await h.manager.configure([connection("a")]);
    await vi.waitFor(() => expect(h.receivers.has("a")).toBe(true));
    const receiver = h.receivers.get("a");
    assert(receiver);
    await receiver.receive(message("task"));
    await receiver.receive({
      ...message("other"),
      target: { kind: "group", id: "room" },
    });
    await receiver.receive({ ...message("help"), text: "/h" });
    expect(receiver.signal.aborted).toBe(false);
    h.gates[0]();
    h.gates[1]();
    await vi.waitFor(() => expect(h.snapshots()[0].busy).toBe(false));
    expect(h.snapshots()[0].issue).toBe("storage");
    expect(h.send).toHaveBeenCalledWith(
      { kind: "group", id: "room" },
      { text: "other" },
      expect.any(AbortSignal),
    );
    await h.manager.dispose();
  });

  it("人工发送与工具回复共用队列，目标固定且不阻塞其他实例", async () => {
    const h = harness();
    await h.manager.configure([connection("a"), connection("b")]);
    await vi.waitFor(() => expect(h.receivers.size).toBe(2));
    let release!: () => void;
    h.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: "accepted",
              parts: [{ index: 0, status: "accepted" }],
            });
        }),
    );
    const target = { kind: "group" as const, id: "group", threadId: "topic" };
    const first = h.manager.send("a", target, { text: "manual" });
    target.id = "changed";
    await h.receivers.get("a")?.receive(message("task"));
    const sender = getChannelMessageSender(
      h.snapshots().find((item) => item.connection.id === "a")?.conversations[0]
        .sessionId ?? "",
    );
    assert(sender);
    const tool = sender({ text: "tool" });
    await h.manager.send(
      "b",
      { kind: "direct", id: "other" },
      { text: "independent" },
    );
    expect(h.send.mock.calls).toHaveLength(2);
    expect(h.send).toHaveBeenNthCalledWith(
      1,
      { kind: "group", id: "group", threadId: "topic" },
      { text: "manual" },
      expect.any(AbortSignal),
    );
    release();
    await Promise.all([first, tool]);
    expect(h.send).toHaveBeenLastCalledWith(
      { kind: "direct", id: "owner" },
      { text: "tool" },
      expect.any(AbortSignal),
    );
    h.gates[0]();
    await h.manager.dispose();
    await expect(
      h.manager.send("a", target, { text: "late" }),
    ).rejects.toThrow();
  });

  it("附件工具成功投递后没有最终正文时不补发空回复", async () => {
    const h = harness();
    await h.manager.configure([connection("a")]);
    await vi.waitFor(() => expect(h.receivers.has("a")).toBe(true));
    await h.receivers.get("a")?.receive({ ...message("file-only"), text: "" });
    const send = getChannelMessageSender(
      h.snapshots().find((item) => item.connection.id === "a")?.conversations[0]
        .sessionId ?? "",
    );
    assert(send);
    await send({ attachments: [{ path: "file.pdf", presentation: "file" }] });
    h.gates[0]();
    await vi.waitFor(() => expect(h.snapshots()[0].busy).toBe(false));
    expect(h.send).toHaveBeenCalledTimes(1);
    await h.manager.dispose();
  });
  it("去重与检查点先于附件下载，下载期间不启动 Agent", async () => {
    const h = harness();
    await h.manager.configure([connection("media")]);
    await vi.waitFor(() => expect(h.receivers.has("media")).toBe(true));
    const receiver = h.receivers.get("media");
    assert(receiver);
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const materialize = vi.fn(async () => {
      expect(h.disk.get("media")?.recentIds).toContain(identity("file"));
      await ready;
      return {
        ...message("file"),
        attachments: [
          {
            id: "asset",
            name: "file.pdf",
            kind: "file" as const,
            status: "ready" as const,
            path: "attachments/asset/file.pdf",
            size: 10,
          },
        ],
      };
    });
    const receiving = receiver.receive(message("file"), materialize);
    await vi.waitFor(() => expect(materialize).toHaveBeenCalledTimes(1));
    expect(h.calls).toEqual([]);
    const duplicate = receiver.receive(message("file"), materialize);
    expect(materialize).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([receiving, duplicate]);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(["media:file"]);
    await expect(
      receiver.receive(message("broken"), async () => {
        throw new ChannelError("storage");
      }),
    ).resolves.toBeUndefined();
    expect(receiver.signal.aborted).toBe(false);
    expect(h.disk.get("media")?.pendingIds).not.toContain(identity("broken"));
    await receiver.receive({
      ...message("other"),
      target: { kind: "group", id: "room" },
    });
    expect(h.calls).toEqual(["media:file", "media:other"]);
    h.gates[0]();
    await vi.waitFor(() =>
      expect(h.snapshots()[0].conversations[0].busy).toBe(false),
    );
    expect(h.snapshots()[0].issue).toBe("storage");
    await h.manager.dispose();
  });
  it("在线改名保留接收任务、当前执行和待处理消息", async () => {
    const h = harness();
    const original = connection("a");
    await h.manager.configure([original]);
    await vi.waitFor(() => expect(h.receivers.has("a")).toBe(true));
    const receiver = h.receivers.get("a");
    await receiver?.receive(message("first"));
    await receiver?.receive(message("queued"));
    try {
      await h.manager.configure([{ ...original, name: "新名称" }]);
      expect(receiver?.signal.aborted).toBe(false);
      expect(h.receivers.get("a")).toBe(receiver);
      expect(h.snapshots()[0]).toMatchObject({
        connection: { ...original, name: "新名称" },
        busy: true,
        queued: 1,
      });
      h.gates[0]();
      await vi.waitFor(() => expect(h.calls).toEqual(["a:first", "a:queued"]));
      h.gates[1]();
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    } finally {
      await h.manager.dispose();
    }
  });

  it("引导模式归并补充并只发送一次回复", async () => {
    const h = harness();
    await h.manager.configure([
      { ...connection("a"), busyMessageMode: "steer" },
    ]);
    await vi.waitFor(() => expect(h.receivers.has("a")).toBe(true));
    await h.receivers.get("a")?.receive(message("first"));
    await h.receivers.get("a")?.receive(message("supplement"));
    expect(h.calls).toEqual(["a:first"]);
    expect(h.inboxes.get("a")?.pendingUsers).toBe(1);
    expect(h.disk.get("a")?.pendingIds).toEqual([
      identity("first"),
      identity("supplement"),
    ]);
    h.gates[0]();
    await vi.waitFor(() => expect(h.disk.get("a")?.pendingIds).toEqual([]));
    expect(h.send).toHaveBeenCalledTimes(1);
    await h.manager.dispose();
  });

  it("中止当前轮清空待执行消息且重连不重放", async () => {
    const h = harness();
    await h.manager.configure([connection("a")]);
    await vi.waitFor(() => expect(h.receivers.has("a")).toBe(true));
    await h.receivers.get("a")?.receive(message("first"));
    await h.receivers.get("a")?.receive(message("queued"));
    for (let index = 0; index < 14; index++)
      await h.receivers.get("a")?.receive(message(`queued-${index}`));
    const waiting = h.receivers
      .get("a")
      ?.receive(message("waiting-for-capacity"));
    const alsoWaiting = h.receivers
      .get("a")
      ?.receive(message("another-waiter"));
    await vi.waitFor(() => expect(h.snapshots()[0].issue).toBe("queue-full"));
    h.cancel();
    h.gates[0]();
    await vi.waitFor(() => expect(h.snapshots()[0].queued).toBe(0));
    await Promise.all([waiting, alsoWaiting]);
    await vi.waitFor(() => expect(h.disk.get("a")?.pendingIds).toEqual([]));
    expect(h.calls).toEqual(["a:first"]);
    expect(h.send).not.toHaveBeenCalled();
    await h.manager.restart("a");
    await vi.waitFor(() =>
      expect(h.receivers.get("a")?.signal.aborted).toBe(false),
    );
    await h.receivers.get("a")?.receive(message("queued"));
    await h.receivers.get("a")?.receive(message("another-waiter"));
    await h.receivers.get("a")?.receive(message("waiting-for-capacity"));
    expect(h.calls).toEqual(["a:first"]);
    await h.manager.dispose();
  });

  it("runs connections independently while keeping each connection ordered and deduplicating restarts", async () => {
    const h = harness();
    await h.manager.configure([connection("a"), connection("b")]);
    await vi.waitFor(() => expect(h.receivers.size).toBe(2));
    await h.receivers.get("a")?.receive(message("first"));
    await h.receivers.get("a")?.receive(message("next"));
    await h.receivers.get("b")?.receive(message("second"));
    expect(h.calls).toEqual(["a:first", "b:second"]);
    expect(h.disk.get("b")?.pendingIds).toEqual([identity("second")]);
    h.gates[0]();
    await vi.waitFor(() =>
      expect(h.calls).toEqual(["a:first", "b:second", "a:next"]),
    );
    h.gates[2]();
    h.gates[1]();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
    await h.manager.restart("a");
    await vi.waitFor(() =>
      expect(
        h.snapshots().find((item) => item.connection.id === "a")?.status,
      ).toBe("online"),
    );
    await h.receivers.get("a")?.receive(message("first"));
    expect(h.calls).toHaveLength(3);
    expect(h.receivers.get("b")?.signal.aborted).toBe(false);
    await h.manager.dispose();
  });

  it("reports interrupted admissions without replaying their Agent turns", async () => {
    const h = harness();
    h.disk.set("a", {
      conversations: [],
      cursor: "saved",
      cursorScope: "a",
      recentIds: [identity("started")],
      pendingIds: [identity("started")],
    });
    await h.manager.configure([connection("a")]);
    await vi.waitFor(() => expect(h.receivers.has("a")).toBe(true));
    expect(h.snapshots()[0].issue).toBe("interrupted");
    await h.receivers.get("a")?.receive(message("started"));
    expect(h.calls).toEqual([]);
    await h.manager.dispose();
  });

  it("stops a connection on checkpoint failure without blocking other connections", async () => {
    const h = harness();
    await h.manager.configure([connection("a"), connection("b")]);
    await vi.waitFor(() => expect(h.receivers.size).toBe(2));
    await h.receivers.get("a")?.receive(message("active"));
    await h.receivers.get("a")?.receive(message("queued"));
    await h.receivers.get("b")?.receive(message("other"));
    h.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(h.receivers.get("a")?.checkpoint("next")).rejects.toThrow(
      "disk full",
    );
    await vi.waitFor(() => expect(h.calls).toEqual(["a:active", "b:other"]));
    expect(h.snapshots()[0]).toMatchObject({
      status: "error",
      issue: "storage",
      queued: 0,
      busy: false,
    });
    expect(h.disk.get("a")?.pendingIds).toEqual([
      identity("active"),
      identity("queued"),
    ]);
    await h.manager.dispose();
  });

  it("discards a replaced login's cursor while preserving admitted message identities", async () => {
    const h = harness();
    h.disk.set("a", {
      conversations: [],
      cursor: "old-cursor",
      cursorScope: "old-bot",
      recentIds: [identity("seen")],
      pendingIds: [],
    });
    await h.manager.configure([connection("a")]);
    await vi.waitFor(() => expect(h.receivers.has("a")).toBe(true));
    expect(h.receivers.get("a")?.cursor).toBe("");
    expect(h.disk.get("a")).toMatchObject({
      cursorScope: "a",
      recentIds: [identity("seen")],
    });
    await h.receivers.get("a")?.receive(message("seen"));
    expect(h.calls).toEqual([]);
    await h.manager.dispose();
  });
});
