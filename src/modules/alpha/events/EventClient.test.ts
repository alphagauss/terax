/**
 * 本文件测试 Alpha 单连接事件客户端。
 * 锁定 selector 引用计数、完整快照 revision 去重和断线后的订阅重放。
 */

import { EventClient } from "@/modules/alpha/events/EventClient";
import type {
  AlphaWebSocketConnection,
  AlphaWebSocketEvent,
} from "@/modules/alpha/native";
import { alphaEventSelectorId } from "@/modules/alpha/events/model";
import { afterEach, describe, expect, it, vi } from "vitest";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function setup() {
  const sends: unknown[] = [];
  const sockets: Array<{
    connection: AlphaWebSocketConnection;
    emit: (event: AlphaWebSocketEvent) => void;
  }> = [];
  const timeouts = new Map<number, () => void>();
  let nextHandle = 1;
  const openSocket = vi.fn(
    async (
      _path: "/api/alpha/events",
      onEvent: (event: AlphaWebSocketEvent) => void,
    ) => {
      const connection: AlphaWebSocketConnection = {
        id: sockets.length + 1,
        send: async (message) => {
          sends.push(message);
        },
        close: vi.fn(async () => {}),
      };
      sockets.push({ connection, emit: onEvent });
      return connection;
    },
  );
  const client = new EventClient({
    openSocket,
    setTimeout: ((callback: () => void) => {
      const handle = nextHandle++;
      timeouts.set(handle, callback);
      return handle;
    }) as typeof globalThis.setTimeout,
    clearTimeout: ((handle: number) => {
      timeouts.delete(handle);
    }) as typeof globalThis.clearTimeout,
  });
  return {
    client,
    sends,
    sockets,
    openSocket,
    runTimeouts: () => {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const callback of pending) callback();
    },
  };
}

const clients: EventClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("EventClient", () => {
  it("同一 selector 只发送一次远程订阅并按 revision 覆盖", async () => {
    const runtime = setup();
    clients.push(runtime.client);
    const selector = { event: "task.updated" as const, key: "bt-1" };
    const first: number[] = [];
    const second: number[] = [];
    const releaseFirst = runtime.client.subscribe(selector, (event) =>
      first.push(event.revision ?? 0),
    );
    const releaseSecond = runtime.client.subscribe(selector, (event) =>
      second.push(event.revision ?? 0),
    );
    await flush();

    expect(runtime.openSocket).toHaveBeenCalledTimes(1);
    expect(runtime.sends).toEqual([
      {
        op: "subscribe",
        version: 1,
        event: "task.updated",
        key: "bt-1",
      },
    ]);

    const emitTask = (revision: number) =>
      runtime.sockets[0].emit({
        kind: "message",
        message: {
          op: "event",
          version: 1,
          event: "task.updated",
          key: "bt-1",
          revision,
          time: "2026-08-30T00:00:00Z",
          data: { revision },
        },
      });
    emitTask(2);
    emitTask(1);
    expect(first).toEqual([2]);
    expect(second).toEqual([2]);

    releaseFirst();
    expect(runtime.sends).toHaveLength(1);
    releaseSecond();
    await flush();
    expect(runtime.sends[1]).toEqual({
      op: "unsubscribe",
      version: 1,
      event: "task.updated",
      key: "bt-1",
    });
    expect(runtime.sockets[0].connection.close).toHaveBeenCalledOnce();
  });

  it("连接关闭后重连并重放仍有本地 callback 的 selector", async () => {
    const runtime = setup();
    clients.push(runtime.client);
    runtime.client.subscribe(
      { event: "market.bar", key: "000001.SZSE|d|forward" },
      vi.fn(),
    );
    await flush();

    runtime.sockets[0].emit({ kind: "closed", code: null, reason: "restart" });
    runtime.runTimeouts();
    await flush();
    runtime.runTimeouts();
    await flush();

    expect(runtime.openSocket).toHaveBeenCalledTimes(2);
    expect(runtime.sends[runtime.sends.length - 1]).toEqual({
      op: "subscribe",
      version: 1,
      event: "market.bar",
      key: "000001.SZSE|d|forward",
    });
  });

  it("重连后清空旧连接 revision，接受服务重启后的新快照", async () => {
    const runtime = setup();
    clients.push(runtime.client);
    const received: number[] = [];
    runtime.client.subscribe(
      { event: "task.updated", key: "bt-restart" },
      (event) => received.push(event.revision ?? 0),
    );
    await flush();

    const emitRevision = (socketIndex: number, revision: number) =>
      runtime.sockets[socketIndex].emit({
        kind: "message",
        message: {
          op: "event",
          version: 1,
          event: "task.updated",
          key: "bt-restart",
          revision,
          time: "2026-08-30T00:00:00Z",
          data: {},
        },
      });
    emitRevision(0, 9);
    runtime.sockets[0].emit({ kind: "closed", code: null, reason: "restart" });
    runtime.runTimeouts();
    await flush();
    runtime.runTimeouts();
    await flush();
    emitRevision(1, 1);

    expect(received).toEqual([9, 1]);
  });

  it("全事件族订阅按各自业务键独立比较 revision", async () => {
    const runtime = setup();
    clients.push(runtime.client);
    const received: string[] = [];
    runtime.client.subscribe({ event: "task.updated", key: null }, (event) =>
      received.push(`${event.key}:${event.revision}`),
    );
    await flush();

    for (const [key, revision] of [
      ["bt-1", 5],
      ["sync-1", 1],
      ["bt-1", 4],
    ] as const) {
      runtime.sockets[0].emit({
        kind: "message",
        message: {
          op: "event",
          version: 1,
          event: "task.updated",
          key,
          revision,
          time: "2026-08-30T00:00:00Z",
          data: {},
        },
      });
    }

    expect(received).toEqual(["bt-1:5", "sync-1:1"]);
  });

  it("通用 selector 与字面星号业务键不会发生本地 ID 冲突", () => {
    expect(alphaEventSelectorId({ event: "task.updated", key: null })).not.toBe(
      alphaEventSelectorId({ event: "task.updated", key: "*" }),
    );
  });

  it("单个 callback 异常不会阻断同 selector 的其他 callback", async () => {
    const runtime = setup();
    clients.push(runtime.client);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const received = vi.fn();
    const selector = { event: "task.updated" as const, key: "bt-1" };
    runtime.client.subscribe(selector, () => {
      throw new Error("listener failed");
    });
    runtime.client.subscribe(selector, received);
    await flush();

    runtime.sockets[0].emit({
      kind: "message",
      message: {
        op: "event",
        version: 1,
        event: "task.updated",
        key: "bt-1",
        revision: 1,
        time: "2026-08-30T00:00:00Z",
        data: {},
      },
    });

    expect(received).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
