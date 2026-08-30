/**
 * 本文件实现当前 WebView 内共享的 Alpha 事件客户端。
 * 客户端复用单条 WebSocket，把远程 selector 转换为普通 callback，并在重连后重放订阅。
 */

import {
  type AlphaWebSocketConnection,
  type AlphaWebSocketEvent,
  openAlphaWebSocket,
} from "@/modules/alpha/native";
import {
  ALPHA_EVENT_TYPES,
  type AlphaEventConnectionState,
  type AlphaEventEnvelope,
  type AlphaEventSelector,
  alphaEventSelectorId,
} from "@/modules/alpha/events/model";
import { z } from "zod";

const RECONNECT_DELAY_MS = 1_000;

const eventEnvelopeSchema = z.object({
  op: z.literal("event"),
  version: z.literal(1),
  event: z.enum(ALPHA_EVENT_TYPES),
  key: z.string().nullable(),
  revision: z.number().int().nonnegative().nullable(),
  time: z.string(),
  data: z.unknown(),
});

type SelectorRecord = {
  selector: AlphaEventSelector;
  listeners: Set<(event: AlphaEventEnvelope) => void>;
  latest: AlphaEventEnvelope | null;
  revisions: Map<string, number>;
};

export type EventClientDependencies = {
  openSocket: (
    path: "/api/alpha/events",
    onEvent: (event: AlphaWebSocketEvent) => void,
  ) => Promise<AlphaWebSocketConnection>;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
};

function defaultDependencies(): EventClientDependencies {
  return {
    openSocket: openAlphaWebSocket,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}

/** 管理一个 WebView 内的单连接事件订阅与 callback。 */
export class EventClient {
  private readonly dependencies: EventClientDependencies;
  private readonly records = new Map<string, SelectorRecord>();
  private readonly stateListeners = new Set<
    (state: AlphaEventConnectionState) => void
  >();
  private socket: AlphaWebSocketConnection | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null =
    null;
  private generation = 0;
  private state: AlphaEventConnectionState = "disconnected";
  private closing = false;

  constructor(dependencies: EventClientDependencies = defaultDependencies()) {
    this.dependencies = dependencies;
  }

  /** 订阅一个公共 selector，重复订阅只增加本地 callback。 */
  subscribe(
    selector: AlphaEventSelector,
    listener: (event: AlphaEventEnvelope) => void,
  ): () => void {
    const id = alphaEventSelectorId(selector);
    let record = this.records.get(id);
    if (!record) {
      record = {
        selector,
        listeners: new Set(),
        latest: null,
        revisions: new Map(),
      };
      this.records.set(id, record);
      if (this.socket) void this.sendSelector(selector, true);
      else void this.ensureConnection();
    }
    record.listeners.add(listener);
    if (record.latest) listener(record.latest);
    return () => this.unsubscribe(id, listener);
  }

  /** 订阅连接状态，用于领域 binding 映射自己的展示状态。 */
  subscribeState(
    listener: (state: AlphaEventConnectionState) => void,
  ): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  /** 释放全部 selector、timer 和底层连接，供测试和应用关闭使用。 */
  async close(): Promise<void> {
    this.closing = true;
    this.generation += 1;
    if (this.reconnectTimer !== null) {
      this.dependencies.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.records.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) await socket.close();
    this.setState("disconnected");
    this.closing = false;
  }

  private unsubscribe(
    id: string,
    listener: (event: AlphaEventEnvelope) => void,
  ): void {
    const record = this.records.get(id);
    if (!record) return;
    record.listeners.delete(listener);
    if (record.listeners.size > 0) return;
    this.records.delete(id);
    if (this.socket) void this.sendSelector(record.selector, false);
    if (this.records.size === 0) void this.closeIdleConnection();
  }

  private async ensureConnection(): Promise<void> {
    if (this.socket || this.connecting || this.records.size === 0) return;
    const generation = ++this.generation;
    this.setState(this.state === "connected" ? "reconnecting" : "connecting");
    this.connecting = this.dependencies
      .openSocket("/api/alpha/events", (event) =>
        this.handleSocketEvent(generation, event),
      )
      .then(async (socket) => {
        if (generation !== this.generation || this.records.size === 0) {
          await socket.close();
          return;
        }
        for (const record of this.records.values()) {
          record.latest = null;
          record.revisions.clear();
        }
        this.socket = socket;
        this.setState("connected");
        for (const record of this.records.values()) {
          await this.sendSelector(record.selector, true);
        }
      })
      .catch(() => {
        if (generation !== this.generation) return;
        this.setState("disconnected");
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
    if (generation !== this.generation || this.closing) return;
    if (event.kind === "message") {
      const parsed = eventEnvelopeSchema.safeParse(event.message);
      if (!parsed.success) return;
      const envelope: AlphaEventEnvelope = {
        event: parsed.data.event,
        key: parsed.data.key,
        revision: parsed.data.revision,
        time: parsed.data.time,
        data: parsed.data.data,
      };
      const record = this.records.get(
        alphaEventSelectorId({ event: envelope.event, key: envelope.key }),
      );
      const general = this.records.get(
        alphaEventSelectorId({ event: envelope.event, key: null }),
      );
      this.publish(record, envelope);
      if (general !== record) this.publish(general, envelope);
      return;
    }
    const socket = this.socket;
    this.socket = null;
    this.generation += 1;
    if (socket) void socket.close();
    this.setState("reconnecting");
    this.scheduleReconnect();
  }

  private publish(
    record: SelectorRecord | undefined,
    event: AlphaEventEnvelope,
  ): void {
    if (!record) return;
    if (event.revision !== null) {
      const revisionKey = event.key ?? "*";
      const previous = record.revisions.get(revisionKey);
      if (previous !== undefined && event.revision <= previous) return;
      record.revisions.set(revisionKey, event.revision);
    }
    if (record.selector.key !== null || event.key === null)
      record.latest = event;
    for (const listener of record.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[alpha-events] 事件 callback 执行失败", error);
      }
    }
  }

  private async sendSelector(
    selector: AlphaEventSelector,
    subscribe: boolean,
  ): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    try {
      await socket.send({
        op: subscribe ? "subscribe" : "unsubscribe",
        version: 1,
        event: selector.event,
        key: selector.key,
      });
    } catch {
      if (this.socket !== socket) return;
      this.socket = null;
      this.generation += 1;
      void socket.close();
      this.setState("reconnecting");
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

  private async closeIdleConnection(): Promise<void> {
    this.generation += 1;
    if (this.reconnectTimer !== null) {
      this.dependencies.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) await socket.close();
    this.setState("disconnected");
  }

  private setState(state: AlphaEventConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

export const alphaEventClient = new EventClient();
