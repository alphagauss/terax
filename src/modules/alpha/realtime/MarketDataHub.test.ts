/**
 * 本文件测试进程内共享实时行情 Hub。
 * 锁定引用计数、单连接复用、sequence 去重与 gap 快照恢复，以及重连后的重新订阅。
 */

import type { MarketBarPage } from "@/modules/alpha/market/model";
import type {
  AlphaWebSocketConnection,
  AlphaWebSocketEvent,
} from "@/modules/alpha/native";
import { MarketDataHub } from "@/modules/alpha/realtime/MarketDataHub";
import type { MarketDataKey } from "@/modules/alpha/realtime/model";
import { afterEach, describe, expect, it, vi } from "vitest";

const KEY: MarketDataKey = {
  vtSymbol: "000001.SZSE",
  interval: "d",
  adjust: "forward",
};
const WIRE_KEY = {
  vt_symbol: "000001.SZSE",
  interval: "d",
  adjust: "forward",
};

function page(sequence: number, date = "2026-08-28"): MarketBarPage {
  return {
    items: [
      {
        time: { kind: "trading-day", date },
        open: 10,
        high: 11,
        low: 9,
        close: 10.5,
        volume: 100,
        amount: 1_000,
        openInterest: null,
      },
    ],
    hasMoreBefore: false,
    nextBefore: null,
    actualStart: date,
    actualEnd: date,
    referenceClose: 10,
    referenceTime: null,
    liveSequence: sequence,
  };
}

function barMessage(sequence: number, date = "2026-08-28") {
  return {
    type: "bar",
    version: 1,
    key: WIRE_KEY,
    sequence,
    bar: {
      time: date,
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 120,
      amount: 1_320,
      open_interest: null,
    },
    is_final: false,
    previous_final: date !== "2026-08-28",
    volume_mode: "cumulative",
  } as const;
}

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
  const frames = new Map<number, FrameRequestCallback>();
  const timeouts = new Map<number, () => void>();
  let nextHandle = 1;
  const loadSnapshot = vi.fn(async () => page(0));
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
  const hub = new MarketDataHub({
    openSocket,
    loadSnapshot,
    now: () => 1_000,
    setTimeout: ((callback: () => void) => {
      const handle = nextHandle++;
      timeouts.set(handle, callback);
      return handle;
    }) as typeof window.setTimeout,
    clearTimeout: ((handle: number) =>
      timeouts.delete(handle)) as typeof window.clearTimeout,
    setInterval: (() => nextHandle++) as unknown as typeof window.setInterval,
    clearInterval: vi.fn() as unknown as typeof window.clearInterval,
    requestFrame: (callback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      frames.delete(handle);
    },
  });
  return {
    hub,
    sends,
    sockets,
    loadSnapshot,
    openSocket,
    flushFrames: () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(1_000);
    },
    runTimeouts: () => {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const callback of pending) callback();
    },
  };
}

const hubs: MarketDataHub[] = [];

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

describe("MarketDataHub", () => {
  it("同一数据键复用订阅，并在最后引用释放时取消", async () => {
    const runtime = setup();
    hubs.push(runtime.hub);
    const first = runtime.hub.acquire(KEY);
    const second = runtime.hub.acquire(KEY);
    await flush();

    expect(runtime.openSocket).toHaveBeenCalledTimes(1);
    expect(runtime.sends).toEqual([
      { type: "subscribe", version: 1, key: WIRE_KEY },
    ]);

    first.release();
    expect(runtime.sends).toHaveLength(1);
    second.release();
    await flush();
    expect(runtime.sends[1]).toEqual({
      type: "unsubscribe",
      version: 1,
      key: WIRE_KEY,
    });
    expect(runtime.sockets[0].connection.close).toHaveBeenCalledTimes(1);
  });

  it("用快照衔接 sequence，忽略重复并在 gap 后重新校准", async () => {
    const runtime = setup();
    hubs.push(runtime.hub);
    const binding = runtime.hub.acquire(KEY);
    const events: string[] = [];
    binding.subscribeData((event) =>
      events.push(`${event.type}:${event.sequence}`),
    );
    await flush();
    runtime.sockets[0].emit({
      kind: "message",
      message: {
        type: "subscribed",
        version: 1,
        key: WIRE_KEY,
        sequence: 0,
      },
    });
    await flush();
    expect(events).toEqual(["snapshot:0"]);

    runtime.sockets[0].emit({ kind: "message", message: barMessage(1) });
    runtime.sockets[0].emit({ kind: "message", message: barMessage(1) });
    runtime.flushFrames();
    expect(events).toEqual(["snapshot:0", "bar:1"]);

    runtime.loadSnapshot.mockResolvedValueOnce(page(3, "2026-08-29"));
    runtime.sockets[0].emit({
      kind: "message",
      message: barMessage(3, "2026-08-29"),
    });
    await flush();
    expect(events).toEqual(["snapshot:0", "bar:1", "snapshot:3"]);
  });

  it("连接关闭后保留消费者并重新订阅和快照", async () => {
    const runtime = setup();
    hubs.push(runtime.hub);
    const binding = runtime.hub.acquire(KEY);
    const states: string[] = [];
    binding.subscribeState((state) => states.push(state.status));
    await flush();

    runtime.sockets[0].emit({ kind: "closed", code: null, reason: "restart" });
    expect(states[states.length - 1]).toBe("reconnecting");
    runtime.runTimeouts();
    await flush();
    runtime.runTimeouts();
    await flush();
    expect(runtime.openSocket).toHaveBeenCalledTimes(2);
    expect(runtime.sends[runtime.sends.length - 1]).toEqual({
      type: "subscribe",
      version: 1,
      key: WIRE_KEY,
    });
  });

  it("后来消费者按顺序重放快照之后已应用的增量", async () => {
    const runtime = setup();
    hubs.push(runtime.hub);
    const first = runtime.hub.acquire(KEY);
    await flush();
    runtime.sockets[0].emit({
      kind: "message",
      message: {
        type: "subscribed",
        version: 1,
        key: WIRE_KEY,
        sequence: 0,
      },
    });
    await flush();
    runtime.sockets[0].emit({ kind: "message", message: barMessage(1) });

    const second = runtime.hub.acquire(KEY);
    const events: string[] = [];
    second.subscribeData((event) =>
      events.push(`${event.type}:${event.sequence}`),
    );

    expect(events).toEqual(["snapshot:0", "bar:1"]);
    runtime.flushFrames();
    expect(events).toEqual(["snapshot:0", "bar:1"]);
    first.release();
    second.release();
  });
});
