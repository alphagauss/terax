/**
 * 本文件实现当前 WebView 进程内共享的 Alpha 实时行情 Hub。
 * Hub 复用单条 WebSocket、按完整数据键引用计数，并在 sequence gap 或重连后用 HTTP 快照重校准。
 */

import { getAlphaBars } from "@/modules/alpha/api";
import type { MarketBarPage } from "@/modules/alpha/market/model";
import { normalizeMarketBars } from "@/modules/alpha/market/normalize";
import {
  type AlphaWebSocketConnection,
  type AlphaWebSocketEvent,
  openAlphaWebSocket,
} from "@/modules/alpha/native";
import { mergeRealtimeBar } from "@/modules/alpha/realtime/aggregation";
import type {
  MarketDataBinding,
  MarketDataKey,
  MarketRealtimeDataEvent,
  MarketRealtimeDelta,
  MarketRealtimeState,
  MarketRealtimeStatus,
} from "@/modules/alpha/realtime/model";
import { marketDataKeyId } from "@/modules/alpha/realtime/model";
import { z } from "zod";

const RECONNECT_DELAY_MS = 1_000;
const SNAPSHOT_RETRY_MS = 1_000;
const FRESHNESS_CHECK_MS = 5_000;
const STALE_AFTER_MS = 12_000;

const wireKeySchema = z.object({
  vt_symbol: z.string(),
  interval: z.enum(["1m", "1h", "d", "w"]),
  adjust: z.enum(["none", "forward", "backward"]),
});

const wireBarSchema = z.object({
  time: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().nullable(),
  amount: z.number().nullable(),
  open_interest: z.number().nullable().optional().default(null),
});

const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribed"),
    version: z.literal(1),
    key: wireKeySchema,
    sequence: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("bar"),
    version: z.literal(1),
    key: wireKeySchema,
    sequence: z.number().int().positive(),
    bar: wireBarSchema,
    is_final: z.boolean(),
    previous_final: z.boolean(),
    volume_mode: z.enum(["cumulative", "incremental"]),
  }),
  z.object({
    type: z.literal("bar_reset"),
    version: z.literal(1),
    key: wireKeySchema,
    sequence: z.number().int().positive(),
    reason: z.enum(["adjustment", "source_reset"]),
  }),
  z.object({
    type: z.literal("market_status"),
    version: z.literal(1),
    key: wireKeySchema,
    status: z.enum(["live", "delayed", "disconnected"]),
  }),
  z.object({
    type: z.literal("resync_required"),
    version: z.literal(1),
    key: wireKeySchema,
  }),
  z.object({
    type: z.literal("error"),
    version: z.literal(1),
    key: wireKeySchema,
    code: z.string(),
    message: z.string(),
  }),
]);

type ServerMessage = z.infer<typeof serverMessageSchema>;
type OpenSocket = (
  path: "/api/alpha/events",
  onEvent: (event: AlphaWebSocketEvent) => void,
) => Promise<AlphaWebSocketConnection>;
type SnapshotLoader = (key: MarketDataKey) => Promise<MarketBarPage>;

type HubDependencies = {
  openSocket: OpenSocket;
  loadSnapshot: SnapshotLoader;
  now: () => number;
  setTimeout: typeof window.setTimeout;
  clearTimeout: typeof window.clearTimeout;
  setInterval: typeof window.setInterval;
  clearInterval: typeof window.clearInterval;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
};

type KeyRecord = {
  key: MarketDataKey;
  bindings: Set<MarketDataBindingImpl>;
  state: MarketRealtimeState;
  upstreamStatus: "live" | "delayed" | "disconnected";
  sequence: number;
  latestBar: MarketRealtimeDelta["bar"] | null;
  snapshotReady: boolean;
  snapshot: (MarketRealtimeDataEvent & { type: "snapshot" }) | null;
  buffered: ServerMessage[];
  resyncGeneration: number;
  resyncPromise: Promise<void> | null;
  resyncAgain: boolean;
  snapshotTimer: number | null;
  lastSeenAt: number;
  pendingEvents: MarketRealtimeDelta[];
  replayEvents: MarketRealtimeDelta[];
  frame: number | null;
};

function publicKey(value: z.infer<typeof wireKeySchema>): MarketDataKey {
  return {
    vtSymbol: value.vt_symbol,
    interval: value.interval,
    adjust: value.adjust,
  };
}

function wireKey(key: MarketDataKey) {
  return {
    vt_symbol: key.vtSymbol,
    interval: key.interval,
    adjust: key.adjust,
  };
}

function defaultDependencies(): HubDependencies {
  const requestFrame =
    typeof globalThis.requestAnimationFrame === "function"
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback: FrameRequestCallback) =>
          globalThis.setTimeout(
            () => callback(Date.now()),
            0,
          ) as unknown as number;
  const cancelFrame =
    typeof globalThis.cancelAnimationFrame === "function"
      ? globalThis.cancelAnimationFrame.bind(globalThis)
      : (handle: number) => globalThis.clearTimeout(handle);
  return {
    openSocket: openAlphaWebSocket,
    loadSnapshot: (key) =>
      getAlphaBars(key.vtSymbol, {
        interval: key.interval,
        adjust: key.adjust,
        limit: 500,
      }),
    now: Date.now,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    requestFrame,
    cancelFrame,
  };
}

class MarketDataBindingImpl implements MarketDataBinding {
  readonly dataKey: string;
  private readonly stateListeners = new Set<
    (state: MarketRealtimeState) => void
  >();
  private readonly dataListeners = new Map<
    (event: MarketRealtimeDataEvent) => void,
    number
  >();
  private released = false;

  constructor(
    private readonly hub: MarketDataHub,
    readonly key: MarketDataKey,
  ) {
    this.dataKey = marketDataKeyId(key);
  }

  /** 返回当前连接与 freshness 状态。 */
  getState(): MarketRealtimeState {
    return this.hub.stateFor(this.key);
  }

  /** 订阅低频连接状态变化。 */
  subscribeState(listener: (state: MarketRealtimeState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  /** 订阅权威快照与经过 sequence 校验的实时增量。 */
  subscribeData(
    listener: (event: MarketRealtimeDataEvent) => void,
  ): () => void {
    this.dataListeners.set(listener, -1);
    const snapshot = this.hub.snapshotFor(this.key);
    if (snapshot) this.deliverData(listener, snapshot);
    for (const event of this.hub.replayEventsFor(this.key)) {
      this.deliverData(listener, event);
    }
    return () => this.dataListeners.delete(listener);
  }

  /** 幂等释放当前消费者引用。 */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.stateListeners.clear();
    this.dataListeners.clear();
    this.hub.release(this);
  }

  notifyState(state: MarketRealtimeState): void {
    for (const listener of this.stateListeners) listener(state);
  }

  notifyData(event: MarketRealtimeDataEvent): void {
    for (const listener of this.dataListeners.keys()) {
      this.deliverData(listener, event);
    }
  }

  private deliverData(
    listener: (event: MarketRealtimeDataEvent) => void,
    event: MarketRealtimeDataEvent,
  ): void {
    const previousSequence = this.dataListeners.get(listener);
    if (previousSequence === undefined) return;
    if (event.type === "bar" && event.sequence <= previousSequence) return;
    this.dataListeners.set(listener, event.sequence);
    listener(event);
  }
}

/** 管理一个 WebView 内全部行情消费者的单连接 Hub。 */
export class MarketDataHub {
  private readonly dependencies: HubDependencies;
  private readonly records = new Map<string, KeyRecord>();
  private socket: AlphaWebSocketConnection | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: number | null = null;
  private freshnessTimer: number | null = null;
  private connectionGeneration = 0;
  private closing = false;

  constructor(dependencies: HubDependencies = defaultDependencies()) {
    this.dependencies = dependencies;
  }

  /** 为完整数据键增加一个消费者引用。 */
  acquire(key: MarketDataKey): MarketDataBinding {
    const id = marketDataKeyId(key);
    let record = this.records.get(id);
    if (!record) {
      record = {
        key,
        bindings: new Set(),
        state: { status: "connecting" },
        upstreamStatus: "disconnected",
        sequence: 0,
        latestBar: null,
        snapshotReady: false,
        snapshot: null,
        buffered: [],
        resyncGeneration: 0,
        resyncPromise: null,
        resyncAgain: false,
        snapshotTimer: null,
        lastSeenAt: 0,
        pendingEvents: [],
        replayEvents: [],
        frame: null,
      };
      this.records.set(id, record);
    }
    const binding = new MarketDataBindingImpl(this, key);
    record.bindings.add(binding);
    this.ensureFreshnessTimer();
    if (this.socket) {
      if (record.bindings.size === 1) void this.sendSubscription(record, true);
    } else {
      void this.ensureConnection();
    }
    return binding;
  }

  stateFor(key: MarketDataKey): MarketRealtimeState {
    return (
      this.records.get(marketDataKeyId(key))?.state ?? {
        status: "disconnected",
      }
    );
  }

  snapshotFor(
    key: MarketDataKey,
  ): (MarketRealtimeDataEvent & { type: "snapshot" }) | null {
    return this.records.get(marketDataKeyId(key))?.snapshot ?? null;
  }

  replayEventsFor(key: MarketDataKey): readonly MarketRealtimeDelta[] {
    return this.records.get(marketDataKeyId(key))?.replayEvents ?? [];
  }

  release(binding: MarketDataBindingImpl): void {
    const id = binding.dataKey;
    const record = this.records.get(id);
    if (!record) return;
    record.bindings.delete(binding);
    if (record.bindings.size > 0) return;
    this.cancelRecordWork(record);
    this.records.delete(id);
    if (this.socket) void this.sendSubscription(record, false);
    if (this.records.size === 0) void this.closeIdleConnection();
  }

  /** 仅供隔离测试释放单例持有的连接、timer 和 rAF。 */
  async close(): Promise<void> {
    this.closing = true;
    this.connectionGeneration += 1;
    if (this.reconnectTimer !== null) {
      this.dependencies.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.freshnessTimer !== null) {
      this.dependencies.clearInterval(this.freshnessTimer);
      this.freshnessTimer = null;
    }
    for (const record of this.records.values()) this.cancelRecordWork(record);
    this.records.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) await socket.close();
    this.closing = false;
  }

  private async ensureConnection(): Promise<void> {
    if (this.socket || this.connecting || this.records.size === 0) return;
    const generation = ++this.connectionGeneration;
    const reconnecting = [...this.records.values()].some(
      (record) => record.sequence > 0 || record.snapshot !== null,
    );
    for (const record of this.records.values()) {
      this.setState(record, reconnecting ? "reconnecting" : "connecting");
    }
    this.connecting = this.dependencies
      .openSocket("/api/alpha/events", (event) =>
        this.handleSocketEvent(generation, event),
      )
      .then(async (socket) => {
        if (
          generation !== this.connectionGeneration ||
          this.records.size === 0
        ) {
          await socket.close();
          return;
        }
        this.socket = socket;
        for (const record of this.records.values()) {
          await this.sendSubscription(record, true);
        }
      })
      .catch(() => {
        if (generation !== this.connectionGeneration) return;
        for (const record of this.records.values()) {
          this.setState(record, "disconnected");
        }
        this.scheduleReconnect();
      })
      .finally(() => {
        this.connecting = null;
        if (!this.socket && this.records.size > 0) this.scheduleReconnect();
      });
    await this.connecting;
  }

  private handleSocketEvent(
    generation: number,
    event: AlphaWebSocketEvent,
  ): void {
    if (generation !== this.connectionGeneration || this.closing) return;
    if (event.kind === "message") {
      const parsed = serverMessageSchema.safeParse(event.message);
      if (parsed.success) this.handleServerMessage(parsed.data);
      return;
    }
    this.socket = null;
    for (const record of this.records.values()) {
      record.snapshotReady = false;
      this.setState(record, "reconnecting");
    }
    this.scheduleReconnect();
  }

  private handleServerMessage(message: ServerMessage): void {
    const key = publicKey(message.key);
    const record = this.records.get(marketDataKeyId(key));
    if (!record) return;
    record.lastSeenAt = this.dependencies.now();
    if (message.type === "subscribed") {
      void this.resync(record);
      return;
    }
    if (message.type === "error") {
      this.setState(record, "disconnected");
      return;
    }
    if (message.type === "market_status") {
      record.upstreamStatus = message.status;
      if (record.snapshotReady) this.setState(record, message.status);
      return;
    }
    if (message.type === "resync_required" || message.type === "bar_reset") {
      record.snapshotReady = false;
      void this.resync(record);
      return;
    }
    if (!record.snapshotReady) {
      record.buffered.push(message);
      return;
    }
    if (message.sequence <= record.sequence) return;
    if (message.sequence !== record.sequence + 1) {
      record.buffered.push(message);
      record.snapshotReady = false;
      void this.resync(record);
      return;
    }
    this.applyBar(record, message);
  }

  private resync(record: KeyRecord): Promise<void> {
    if (record.resyncPromise) {
      record.resyncAgain = true;
      return record.resyncPromise;
    }
    const promise = this.performResync(record).finally(() => {
      if (record.resyncPromise !== promise) return;
      record.resyncPromise = null;
      if (
        record.resyncAgain &&
        this.records.get(marketDataKeyId(record.key)) === record
      ) {
        record.resyncAgain = false;
        void this.resync(record);
      }
    });
    record.resyncPromise = promise;
    return promise;
  }

  /** 执行单次 HTTP 权威快照读取，同键的并发要求由外层合并。 */
  private async performResync(record: KeyRecord): Promise<void> {
    const generation = ++record.resyncGeneration;
    if (record.snapshotTimer !== null) {
      this.dependencies.clearTimeout(record.snapshotTimer);
      record.snapshotTimer = null;
    }
    try {
      const page = await this.dependencies.loadSnapshot(record.key);
      if (
        generation !== record.resyncGeneration ||
        !this.records.has(marketDataKeyId(record.key))
      ) {
        return;
      }
      record.sequence = page.liveSequence;
      record.latestBar = page.items[page.items.length - 1] ?? null;
      record.snapshotReady = true;
      record.replayEvents = [];
      record.snapshot = {
        type: "snapshot",
        sequence: page.liveSequence,
        bars: page.items,
      };
      for (const binding of record.bindings)
        binding.notifyData(record.snapshot);
      const buffered = record.buffered
        .filter(
          (item): item is Extract<ServerMessage, { type: "bar" }> =>
            item.type === "bar",
        )
        .sort((left, right) => left.sequence - right.sequence);
      record.buffered = [];
      for (const message of buffered) {
        if (message.sequence <= record.sequence) continue;
        if (message.sequence !== record.sequence + 1) {
          record.buffered.push(message);
          record.snapshotReady = false;
          void this.resync(record);
          return;
        }
        this.applyBar(record, message);
      }
      this.setState(record, record.upstreamStatus);
    } catch {
      if (generation !== record.resyncGeneration) return;
      this.setState(record, "disconnected");
      record.snapshotTimer = this.dependencies.setTimeout(() => {
        record.snapshotTimer = null;
        void this.resync(record);
      }, SNAPSHOT_RETRY_MS);
    }
  }

  private applyBar(
    record: KeyRecord,
    message: Extract<ServerMessage, { type: "bar" }>,
  ): void {
    const [bar] = normalizeMarketBars(
      [
        {
          ...message.bar,
          openInterest: message.bar.open_interest,
        },
      ],
      record.key.interval,
    );
    record.sequence = message.sequence;
    const merged = mergeRealtimeBar(record.latestBar, bar, message.volume_mode);
    if (!merged.bar) return;
    record.latestBar = merged.bar;
    const event: MarketRealtimeDelta = {
      type: "bar",
      sequence: message.sequence,
      bar: merged.bar,
      isFinal: message.is_final,
      previousFinal: message.previous_final,
      volumeMode: "cumulative",
    };
    record.replayEvents.push(event);
    if (record.replayEvents.length > 512) record.replayEvents.shift();
    record.pendingEvents.push(event);
    if (record.frame !== null) return;
    record.frame = this.dependencies.requestFrame(() => {
      record.frame = null;
      const events = record.pendingEvents;
      record.pendingEvents = [];
      for (const event of events) {
        for (const binding of record.bindings) binding.notifyData(event);
      }
    });
  }

  private setState(record: KeyRecord, status: MarketRealtimeStatus): void {
    if (record.state.status === status) return;
    record.state = { status };
    for (const binding of record.bindings) binding.notifyState(record.state);
  }

  private async sendSubscription(
    record: KeyRecord,
    subscribe: boolean,
  ): Promise<void> {
    if (!this.socket) return;
    try {
      await this.socket.send({
        type: subscribe ? "subscribe" : "unsubscribe",
        version: 1,
        key: wireKey(record.key),
      });
    } catch {
      this.socket = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (
      this.reconnectTimer !== null ||
      this.records.size === 0 ||
      this.closing
    ) {
      return;
    }
    this.reconnectTimer = this.dependencies.setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnection();
    }, RECONNECT_DELAY_MS);
  }

  private ensureFreshnessTimer(): void {
    if (this.freshnessTimer !== null) return;
    this.freshnessTimer = this.dependencies.setInterval(() => {
      const now = this.dependencies.now();
      for (const record of this.records.values()) {
        if (
          record.snapshotReady &&
          record.lastSeenAt > 0 &&
          now - record.lastSeenAt > STALE_AFTER_MS
        ) {
          this.setState(record, "stale");
        }
      }
    }, FRESHNESS_CHECK_MS);
  }

  private cancelRecordWork(record: KeyRecord): void {
    record.resyncGeneration += 1;
    record.resyncAgain = false;
    if (record.snapshotTimer !== null) {
      this.dependencies.clearTimeout(record.snapshotTimer);
      record.snapshotTimer = null;
    }
    if (record.frame !== null) {
      this.dependencies.cancelFrame(record.frame);
      record.frame = null;
    }
    record.pendingEvents = [];
  }

  private async closeIdleConnection(): Promise<void> {
    this.connectionGeneration += 1;
    if (this.reconnectTimer !== null) {
      this.dependencies.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.freshnessTimer !== null) {
      this.dependencies.clearInterval(this.freshnessTimer);
      this.freshnessTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) await socket.close();
  }
}

export const marketDataHub = new MarketDataHub();
