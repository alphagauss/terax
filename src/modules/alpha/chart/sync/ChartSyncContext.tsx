/**
 * 本文件实现 Alpha 工作台内的轻量图表同步总线。
 * Provider 按帧合并范围与十字线事件，按来源、组和兼容性直接派发，不把运行时事件写入 React 状态或持久化。
 */

import type { MarketChartInterval } from "@/modules/alpha/chart/model";
import { createRafBatcher } from "@/modules/alpha/chart/rafBatcher";
import type { MarketAdjust, MarketTime } from "@/modules/alpha/market/model";
import type { AlphaChartSyncConfig } from "@/modules/alpha/workstation/model";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";

export type ChartSyncCompatibility = {
  interval: MarketChartInterval;
  adjust: MarketAdjust;
};

export type ChartTimeRange = {
  from: MarketTime;
  to: MarketTime;
};

export type ChartTimeRangeEvent = {
  sourcePanelId: string;
  groupId: string;
  compatibility: ChartSyncCompatibility;
  range: ChartTimeRange;
};

export type ChartCrosshairEvent = {
  sourcePanelId: string;
  groupId: string;
  compatibility: ChartSyncCompatibility;
  time: MarketTime | null;
};

type ChartSyncSubscriberHandlers = {
  onRange(range: ChartTimeRange): void;
  onCrosshair(time: MarketTime | null): void;
};

type ChartSyncSubscriber = {
  panelId: string;
  groupId: string;
  compatibility: ChartSyncCompatibility;
  handlers: ChartSyncSubscriberHandlers;
};

export type FinancialChartSyncRuntime = {
  rangeEnabled: boolean;
  crosshairEnabled: boolean;
  publishRange(range: ChartTimeRange): void;
  publishCrosshair(time: MarketTime | null): void;
  subscribe(handlers: ChartSyncSubscriberHandlers): () => void;
};

type ChartSyncContextValue = {
  config: AlphaChartSyncConfig;
  publishRange(event: ChartTimeRangeEvent): void;
  publishCrosshair(event: ChartCrosshairEvent): void;
  subscribe(subscriber: ChartSyncSubscriber): () => void;
};

const ChartSyncContext = createContext<ChartSyncContextValue | null>(null);

/** 首版同步只接受周期和复权都完全一致的面板。 */
function isCompatible(
  left: ChartSyncCompatibility,
  right: ChartSyncCompatibility,
): boolean {
  return left.interval === right.interval && left.adjust === right.adjust;
}

/**
 * 为当前工作台提供隔离的多图同步总线。
 *
 * 两种 batcher 按需创建；开关关闭时会取消待派发帧，不保留事件快照。
 */
export function ChartSyncProvider({
  config,
  children,
}: {
  config: AlphaChartSyncConfig;
  children: ReactNode;
}) {
  const stableConfig = useMemo<AlphaChartSyncConfig>(
    () => ({
      groupId: config.groupId,
      rangeEnabled: config.rangeEnabled,
      crosshairEnabled: config.crosshairEnabled,
    }),
    [config.crosshairEnabled, config.groupId, config.rangeEnabled],
  );
  const configRef = useRef(stableConfig);
  configRef.current = stableConfig;
  const subscribersRef = useRef(new Map<number, ChartSyncSubscriber>());
  const nextSubscriberIdRef = useRef(0);
  const rangeBatcherRef = useRef<ReturnType<
    typeof createRafBatcher<ChartTimeRangeEvent>
  > | null>(null);
  const crosshairBatcherRef = useRef<ReturnType<
    typeof createRafBatcher<ChartCrosshairEvent>
  > | null>(null);

  const dispatchRange = useCallback((event: ChartTimeRangeEvent) => {
    const current = configRef.current;
    if (!current.rangeEnabled || event.groupId !== current.groupId) return;
    for (const subscriber of subscribersRef.current.values()) {
      if (
        subscriber.panelId !== event.sourcePanelId &&
        subscriber.groupId === event.groupId &&
        isCompatible(subscriber.compatibility, event.compatibility)
      ) {
        subscriber.handlers.onRange(event.range);
      }
    }
  }, []);

  const dispatchCrosshair = useCallback((event: ChartCrosshairEvent) => {
    const current = configRef.current;
    if (!current.crosshairEnabled || event.groupId !== current.groupId) return;
    for (const subscriber of subscribersRef.current.values()) {
      if (
        subscriber.panelId !== event.sourcePanelId &&
        subscriber.groupId === event.groupId &&
        isCompatible(subscriber.compatibility, event.compatibility)
      ) {
        subscriber.handlers.onCrosshair(event.time);
      }
    }
  }, []);

  const publishRange = useCallback(
    (event: ChartTimeRangeEvent) => {
      const current = configRef.current;
      if (!current.rangeEnabled || event.groupId !== current.groupId) return;
      rangeBatcherRef.current ??= createRafBatcher(dispatchRange);
      rangeBatcherRef.current.schedule(event);
    },
    [dispatchRange],
  );

  const publishCrosshair = useCallback(
    (event: ChartCrosshairEvent) => {
      const current = configRef.current;
      if (!current.crosshairEnabled || event.groupId !== current.groupId)
        return;
      crosshairBatcherRef.current ??= createRafBatcher(dispatchCrosshair);
      crosshairBatcherRef.current.schedule(event);
    },
    [dispatchCrosshair],
  );

  const subscribe = useCallback((subscriber: ChartSyncSubscriber) => {
    nextSubscriberIdRef.current += 1;
    const subscriberId = nextSubscriberIdRef.current;
    subscribersRef.current.set(subscriberId, subscriber);
    return () => subscribersRef.current.delete(subscriberId);
  }, []);

  useEffect(() => {
    if (!stableConfig.rangeEnabled) {
      rangeBatcherRef.current?.cancel();
      rangeBatcherRef.current = null;
    }
    if (!stableConfig.crosshairEnabled) {
      crosshairBatcherRef.current?.cancel();
      crosshairBatcherRef.current = null;
    }
  }, [stableConfig.crosshairEnabled, stableConfig.rangeEnabled]);

  useEffect(
    () => () => {
      rangeBatcherRef.current?.cancel();
      crosshairBatcherRef.current?.cancel();
      subscribersRef.current.clear();
    },
    [],
  );

  const value = useMemo<ChartSyncContextValue>(
    () => ({
      config: stableConfig,
      publishRange,
      publishCrosshair,
      subscribe,
    }),
    [stableConfig, publishCrosshair, publishRange, subscribe],
  );

  return (
    <ChartSyncContext.Provider value={value}>
      {children}
    </ChartSyncContext.Provider>
  );
}

/**
 * 为一个稳定 panel ID 创建可选同步桥。
 *
 * 两个开关都关闭或组件不在 Provider 内时返回 `null`，公共图表不会注册同步监听。
 */
export function useChartSyncPanel(
  panelId: string,
  compatibility: ChartSyncCompatibility,
): FinancialChartSyncRuntime | null {
  const context = useContext(ChartSyncContext);
  return useMemo(() => {
    if (
      !context ||
      (!context.config.rangeEnabled && !context.config.crosshairEnabled)
    ) {
      return null;
    }
    const groupId = context.config.groupId;
    return {
      rangeEnabled: context.config.rangeEnabled,
      crosshairEnabled: context.config.crosshairEnabled,
      publishRange: (range) =>
        context.publishRange({
          sourcePanelId: panelId,
          groupId,
          compatibility,
          range,
        }),
      publishCrosshair: (time) =>
        context.publishCrosshair({
          sourcePanelId: panelId,
          groupId,
          compatibility,
          time,
        }),
      subscribe: (handlers) =>
        context.subscribe({
          panelId,
          groupId,
          compatibility,
          handlers,
        }),
    };
  }, [compatibility, context, panelId]);
}
