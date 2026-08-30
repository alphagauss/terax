/**
 * 本文件把通用 Alpha EventClient 适配为金融图表使用的实时行情 binding。
 * 它只验证公共事件、归一化完整 bar 并映射连接状态，不维护 sequence 或 HTTP 快照。
 */

import {
  alphaEventClient,
  type EventClient,
} from "@/modules/alpha/events/EventClient";
import type { AlphaEventConnectionState } from "@/modules/alpha/events/model";
import { normalizeMarketBars } from "@/modules/alpha/market/normalize";
import type {
  MarketDataBinding,
  MarketDataKey,
  MarketRealtimeDataEvent,
  MarketRealtimeState,
} from "@/modules/alpha/realtime/model";
import { marketDataKeyId } from "@/modules/alpha/realtime/model";
import { z } from "zod";

const barEventSchema = z.object({
  key: z.object({
    vt_symbol: z.string(),
    interval: z.enum(["1m", "1h", "d", "w"]),
    adjust: z.enum(["none", "forward", "backward"]),
  }),
  bar: z.object({
    time: z.string(),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number().nullable(),
    amount: z.number().nullable(),
    open_interest: z.number().nullable().optional().default(null),
  }),
  is_final: z.boolean(),
  previous_final: z.boolean(),
  volume_mode: z.enum(["cumulative", "incremental"]),
});

const statusEventSchema = z.object({
  status: z.enum(["live", "delayed", "disconnected"]),
});

/** 把通用事件连接状态映射为行情面板展示状态。 */
function connectionState(
  state: AlphaEventConnectionState,
): MarketRealtimeState {
  if (state === "connected") return { status: "connecting" };
  return { status: state };
}

/** 持有一个图表消费者的 bar、状态 callback 和释放句柄。 */
class MarketDataBindingImpl implements MarketDataBinding {
  readonly dataKey: string;
  private readonly key: MarketDataKey;
  private state: MarketRealtimeState = { status: "connecting" };
  private latest: MarketRealtimeDataEvent | null = null;
  private readonly stateListeners = new Set<
    (state: MarketRealtimeState) => void
  >();
  private readonly dataListeners = new Set<
    (event: MarketRealtimeDataEvent) => void
  >();
  private readonly releases: Array<() => void>;
  private released = false;

  constructor(client: EventClient, key: MarketDataKey) {
    this.key = key;
    this.dataKey = marketDataKeyId(key);
    this.releases = [
      client.subscribeState((state) => {
        if (state === "connected" && this.state.status === "live") return;
        this.setState(connectionState(state));
      }),
      client.subscribe(
        { event: "market.status", key: this.dataKey },
        (event) => {
          const parsed = statusEventSchema.safeParse(event.data);
          if (parsed.success) this.setState({ status: parsed.data.status });
        },
      ),
      client.subscribe({ event: "market.bar", key: this.dataKey }, (event) => {
        const parsed = barEventSchema.safeParse(event.data);
        if (!parsed.success) return;
        const [bar] = normalizeMarketBars(
          [
            {
              ...parsed.data.bar,
              openInterest: parsed.data.bar.open_interest,
            },
          ],
          this.key.interval,
        );
        const next: MarketRealtimeDataEvent = {
          type: "bar",
          bar,
          isFinal: parsed.data.is_final,
          previousFinal: parsed.data.previous_final,
          volumeMode: parsed.data.volume_mode,
        };
        this.latest = next;
        for (const listener of this.dataListeners) listener(next);
      }),
    ];
  }

  getState(): MarketRealtimeState {
    return this.state;
  }

  subscribeState(listener: (state: MarketRealtimeState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  subscribeData(
    listener: (event: MarketRealtimeDataEvent) => void,
  ): () => void {
    this.dataListeners.add(listener);
    if (this.latest) listener(this.latest);
    return () => this.dataListeners.delete(listener);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const release of this.releases) release();
    this.stateListeners.clear();
    this.dataListeners.clear();
  }

  private setState(state: MarketRealtimeState): void {
    if (state.status === this.state.status) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

/** 创建一个由通用 EventClient 驱动的图表行情 binding。 */
export function acquireMarketData(key: MarketDataKey): MarketDataBinding {
  return new MarketDataBindingImpl(alphaEventClient, key);
}
