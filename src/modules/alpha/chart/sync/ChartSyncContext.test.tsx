/**
 * 本文件测试 Alpha 工作台图表同步总线。
 * 重点锁定独立按帧末值、来源防环、周期复权兼容过滤、关闭快速路径和订阅清理。
 */

// @vitest-environment happy-dom

import {
  ChartSyncProvider,
  useChartSyncPanel,
  type ChartSyncCompatibility,
  type ChartTimeRange,
  type FinancialChartSyncRuntime,
} from "@/modules/alpha/chart/sync/ChartSyncContext";
import type { MarketTime } from "@/modules/alpha/market/model";
import type { AlphaChartSyncConfig } from "@/modules/alpha/workstation/model";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const day = (date: string): MarketTime => ({ kind: "trading-day", date });

const firstRange: ChartTimeRange = {
  from: day("2026-01-01"),
  to: day("2026-02-01"),
};
const latestRange: ChartTimeRange = {
  from: day("2026-03-01"),
  to: day("2026-04-01"),
};

function config(
  rangeEnabled: boolean,
  crosshairEnabled: boolean,
): AlphaChartSyncConfig {
  return { groupId: "primary", rangeEnabled, crosshairEnabled };
}

function PanelProbe({
  panelId,
  compatibility,
  onRuntime,
  onRange,
  onCrosshair,
}: {
  panelId: string;
  compatibility: ChartSyncCompatibility;
  onRuntime: (runtime: FinancialChartSyncRuntime | null) => void;
  onRange: (range: ChartTimeRange) => void;
  onCrosshair: (time: MarketTime | null) => void;
}) {
  const runtime = useChartSyncPanel(panelId, compatibility);
  useEffect(() => onRuntime(runtime), [onRuntime, runtime]);
  useEffect(
    () => runtime?.subscribe({ onRange, onCrosshair }),
    [onCrosshair, onRange, runtime],
  );
  return null;
}

describe("ChartSyncContext", () => {
  let frames: FrameRequestCallback[];
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.restoreAllMocks();
  });

  it("范围和十字线各自按帧保留末值并跳过来源面板", () => {
    let source: FinancialChartSyncRuntime | null = null;
    const sourceRange = vi.fn();
    const sourceCrosshair = vi.fn();
    const targetRange = vi.fn();
    const targetCrosshair = vi.fn();
    const compatibility = { interval: "d", adjust: "forward" } as const;

    act(() =>
      root?.render(
        <ChartSyncProvider config={config(true, true)}>
          <PanelProbe
            panelId="source"
            compatibility={compatibility}
            onRuntime={(runtime) => {
              source = runtime;
            }}
            onRange={sourceRange}
            onCrosshair={sourceCrosshair}
          />
          <PanelProbe
            panelId="target"
            compatibility={compatibility}
            onRuntime={() => undefined}
            onRange={targetRange}
            onCrosshair={targetCrosshair}
          />
        </ChartSyncProvider>,
      ),
    );

    act(() => {
      source?.publishRange(firstRange);
      source?.publishRange(latestRange);
      source?.publishCrosshair(day("2026-03-01"));
      source?.publishCrosshair(day("2026-04-01"));
    });
    expect(frames).toHaveLength(2);

    act(() => {
      for (const callback of frames.splice(0)) callback(16);
    });

    expect(sourceRange).not.toHaveBeenCalled();
    expect(sourceCrosshair).not.toHaveBeenCalled();
    expect(targetRange).toHaveBeenCalledOnce();
    expect(targetRange).toHaveBeenCalledWith(latestRange);
    expect(targetCrosshair).toHaveBeenCalledOnce();
    expect(targetCrosshair).toHaveBeenCalledWith(day("2026-04-01"));
  });

  it("独立开关和周期复权兼容规则分别过滤事件", () => {
    let source: FinancialChartSyncRuntime | null = null;
    const compatibleRange = vi.fn();
    const compatibleCrosshair = vi.fn();
    const incompatibleRange = vi.fn();

    act(() =>
      root?.render(
        <ChartSyncProvider config={config(true, false)}>
          <PanelProbe
            panelId="source"
            compatibility={{ interval: "d", adjust: "forward" }}
            onRuntime={(runtime) => {
              source = runtime;
            }}
            onRange={() => undefined}
            onCrosshair={() => undefined}
          />
          <PanelProbe
            panelId="compatible"
            compatibility={{ interval: "d", adjust: "forward" }}
            onRuntime={() => undefined}
            onRange={compatibleRange}
            onCrosshair={compatibleCrosshair}
          />
          <PanelProbe
            panelId="incompatible"
            compatibility={{ interval: "1h", adjust: "forward" }}
            onRuntime={() => undefined}
            onRange={incompatibleRange}
            onCrosshair={() => undefined}
          />
        </ChartSyncProvider>,
      ),
    );

    act(() => {
      source?.publishRange(latestRange);
      source?.publishCrosshair(day("2026-04-01"));
      for (const callback of frames.splice(0)) callback(16);
    });

    expect(compatibleRange).toHaveBeenCalledWith(latestRange);
    expect(compatibleCrosshair).not.toHaveBeenCalled();
    expect(incompatibleRange).not.toHaveBeenCalled();
  });

  it("关闭时不调度动画帧，面板卸载后不保留订阅", () => {
    let disabledRuntime: FinancialChartSyncRuntime | null | undefined;
    const targetRange = vi.fn();
    const compatibility = { interval: "d", adjust: "forward" } as const;
    act(() =>
      root?.render(
        <ChartSyncProvider config={config(false, false)}>
          <PanelProbe
            panelId="disabled"
            compatibility={compatibility}
            onRuntime={(runtime) => {
              disabledRuntime = runtime;
            }}
            onRange={() => undefined}
            onCrosshair={() => undefined}
          />
        </ChartSyncProvider>,
      ),
    );
    expect(disabledRuntime).toBeNull();
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();

    let source: FinancialChartSyncRuntime | null = null;
    act(() =>
      root?.render(
        <ChartSyncProvider config={config(true, false)}>
          <PanelProbe
            panelId="source"
            compatibility={compatibility}
            onRuntime={(runtime) => {
              source = runtime;
            }}
            onRange={() => undefined}
            onCrosshair={() => undefined}
          />
          <PanelProbe
            panelId="target"
            compatibility={compatibility}
            onRuntime={() => undefined}
            onRange={targetRange}
            onCrosshair={() => undefined}
          />
        </ChartSyncProvider>,
      ),
    );
    act(() =>
      root?.render(
        <ChartSyncProvider config={config(true, false)}>
          <PanelProbe
            panelId="source"
            compatibility={compatibility}
            onRuntime={(runtime) => {
              source = runtime;
            }}
            onRange={() => undefined}
            onCrosshair={() => undefined}
          />
        </ChartSyncProvider>,
      ),
    );

    act(() => {
      source?.publishRange(latestRange);
      for (const callback of frames.splice(0)) callback(16);
    });
    expect(targetRange).not.toHaveBeenCalled();
  });

  it("同步字段未变化时复用 panel runtime", () => {
    const runtimes: Array<FinancialChartSyncRuntime | null> = [];
    const onRuntime = (runtime: FinancialChartSyncRuntime | null) => {
      runtimes.push(runtime);
    };
    const compatibility = { interval: "d", adjust: "forward" } as const;
    const panel = (
      <PanelProbe
        panelId="stable"
        compatibility={compatibility}
        onRuntime={onRuntime}
        onRange={() => undefined}
        onCrosshair={() => undefined}
      />
    );

    act(() =>
      root?.render(
        <ChartSyncProvider config={config(true, false)}>
          {panel}
        </ChartSyncProvider>,
      ),
    );
    const first = runtimes[runtimes.length - 1];
    act(() =>
      root?.render(
        <ChartSyncProvider config={{ ...config(true, false) }}>
          {panel}
        </ChartSyncProvider>,
      ),
    );

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]).toBe(first);
  });
});
