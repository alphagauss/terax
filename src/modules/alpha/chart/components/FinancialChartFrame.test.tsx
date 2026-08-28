/**
 * 本文件测试 Alpha 公共金融图表外壳的基础交互。
 * 重点锁定重置与导出、指标、对比和实时入口，以及涨跌幅使用上一根收盘价计算。
 */

// @vitest-environment happy-dom

import type { MarketBar } from "@/modules/alpha/market/model";
import {
  act,
  createElement,
  type ReactNode,
  type Ref,
  useImperativeHandle,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chartProps: null as Record<string, unknown> | null,
  resetView: vi.fn(),
  returnToLatest: vi.fn(),
  takeScreenshot: vi.fn(),
  buildMarketBarsCsv: vi.fn(() => "csv"),
  downloadChartBlob: vi.fn(),
  downloadChartPng: vi.fn(() => Promise.resolve()),
  toastError: vi.fn(),
  dialogProps: null as Record<string, unknown> | null,
}));

vi.mock("@/modules/alpha/chart/components/FinancialChart", () => ({
  FinancialChart: (
    props: Record<string, unknown> & {
      ref?: Ref<{
        resetView(): void;
        returnToLatest(): void;
        takeScreenshot(): HTMLCanvasElement | null;
      }>;
    },
  ) => {
    const { ref, ...chartProps } = props;
    useImperativeHandle(
      ref,
      () => ({
        resetView: mocks.resetView,
        returnToLatest: mocks.returnToLatest,
        takeScreenshot: mocks.takeScreenshot,
      }),
      [],
    );
    mocks.chartProps = chartProps;
    return createElement("div", { "data-testid": "financial-chart" });
  },
}));

vi.mock("@/modules/alpha/chart/export/chartExport", () => ({
  MAX_CHART_EXPORT_BARS: 2,
  buildChartExportFilename: (
    symbol: string | null,
    interval: string,
    extension: string,
  ) => `chart-${symbol ?? "chart"}-${interval}.${extension}`,
  buildMarketBarsCsv: mocks.buildMarketBarsCsv,
  downloadChartBlob: mocks.downloadChartBlob,
  downloadChartPng: mocks.downloadChartPng,
}));

vi.mock("@/components/menu/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
  }) =>
    createElement(
      "button",
      { type: "button", disabled, onClick: onSelect },
      children,
    ),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

vi.mock("@/modules/alpha/chart/studies/IndicatorDialog", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.dialogProps = props;
    return createElement("div", { "data-testid": "indicator-dialog" });
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key === "data.chart.accessibility.summary"
        ? `${key}:${String(values?.time)}:${String(values?.close)}`
        : key,
    i18n: { language: "en" },
  }),
}));

import { FinancialChartFrame } from "@/modules/alpha/chart/components/FinancialChartFrame";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

function marketBar(date: string, open: number, close: number): MarketBar {
  return {
    time: { kind: "trading-day", date },
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 100,
    amount: 1_000,
    openInterest: null,
  };
}

describe("FinancialChartFrame", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.chartProps = null;
    mocks.dialogProps = null;
    mocks.takeScreenshot.mockReturnValue(document.createElement("canvas"));
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("按上一根收盘价显示涨跌幅，并向图表传递重置命令", () => {
    const bars = [
      marketBar("2026-07-29", 9, 10),
      marketBar("2026-07-30", 20, 11),
    ];
    const onOptionsChange = vi.fn();
    act(() => {
      root?.render(
        createElement(FinancialChartFrame, {
          bars,
          dataKey: "000001.SZSE|d|forward",
          symbol: "000001.SZSE",
          options: {
            interval: "d",
            adjust: "forward",
            chartType: "candlestick",
            showVolume: true,
            paneRatios: { main: 8, volume: 2 },
          },
          metadata: {
            vtSymbol: "000001.SZSE",
            name: "平安银行",
            exchange: "SZSE",
            timezone: "Asia/Shanghai",
            minMove: 0.01,
            pricePrecision: 2,
            volumeUnit: "share",
            priceColorConvention: "up-red",
            intervals: ["d"],
          },
          priceReference: {
            previousClose: 10,
            referenceTime: {
              kind: "trading-day",
              date: "2026-07-29",
            },
          },
          availableIntervals: ["d"],
          density: "compact",
          status: "ready",
          historyError: false,
          hasMoreBefore: false,
          loadingMore: false,
          visible: true,
          onOptionsChange,
          onRequestMore: vi.fn(),
          onRetry: vi.fn(),
        }),
      );
    });

    expect(container.textContent).toContain("10.00%");
    expect(
      container.querySelector('[aria-label="data.chart.actions.menu"]'),
    ).toBeNull();

    const lineButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "data.chart.types.line",
    );
    act(() => lineButton?.click());
    expect(onOptionsChange).toHaveBeenCalledWith({
      interval: "d",
      adjust: "forward",
      chartType: "line",
      showVolume: true,
      paneRatios: { main: 8, volume: 2 },
    });

    const onCrosshairChange = mocks.chartProps?.onCrosshairChange as (
      bar: MarketBar | null,
    ) => void;
    act(() => onCrosshairChange({ ...bars[0] }));
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "data.chart.accessibility.summary:2026-07-29:10.00",
    );
    act(() => onCrosshairChange(null));
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "data.chart.accessibility.summary:2026-07-30:11.00",
    );
    expect(container.textContent).toContain("10.00%");

    const reset = container.querySelector<HTMLButtonElement>(
      '[aria-label="data.chart.resetView"]',
    );
    act(() => reset?.click());

    expect(mocks.resetView).toHaveBeenCalledOnce();
    expect(mocks.chartProps).toMatchObject({
      metadata: expect.objectContaining({ timezone: "Asia/Shanghai" }),
      priceReference: expect.objectContaining({ previousClose: 10 }),
      showVolume: true,
      paneRatios: { main: 8, volume: 2 },
    });
  });

  it("工作台密度切换成交量并回传 pane 比例", () => {
    const onOptionsChange = vi.fn();
    const options = {
      interval: "d" as const,
      adjust: "forward" as const,
      chartType: "candlestick" as const,
      showVolume: true,
      paneRatios: { main: 8, volume: 2 },
    };
    act(() => {
      root?.render(
        createElement(FinancialChartFrame, {
          bars: [marketBar("2026-07-30", 10, 11)],
          dataKey: "000001.SZSE|d|forward",
          symbol: "000001.SZSE",
          options,
          metadata: null,
          priceReference: { previousClose: 10, referenceTime: null },
          availableIntervals: ["d"],
          density: "panel",
          status: "ready",
          historyError: false,
          hasMoreBefore: false,
          loadingMore: false,
          visible: true,
          onOptionsChange,
          onRequestMore: vi.fn(),
          onRetry: vi.fn(),
        }),
      );
    });

    const volume = container.querySelector<HTMLButtonElement>(
      '[aria-label="data.chart.controls.volume"]',
    );
    act(() => volume?.click());
    expect(onOptionsChange).toHaveBeenCalledWith({
      ...options,
      showVolume: false,
    });

    act(() => {
      const change = mocks.chartProps?.onPaneRatiosChange as (
        ratios: Record<string, number>,
      ) => void;
      change({ main: 7, volume: 3 });
    });
    expect(onOptionsChange).toHaveBeenLastCalledWith({
      ...options,
      paneRatios: { main: 7, volume: 3 },
    });
    expect(
      container.querySelector('[aria-label="data.chart.actions.menu"]'),
    ).not.toBeNull();
  });

  it("工作台菜单导出 PNG 和 CSV，并反馈下载失败", async () => {
    const bars = [marketBar("2026-07-30", 10, 11)];
    act(() => {
      root?.render(
        createElement(FinancialChartFrame, {
          bars,
          dataKey: "000001.SZSE|d|forward",
          symbol: "000001.SZSE",
          options: {
            interval: "d",
            adjust: "forward",
            chartType: "candlestick",
            showVolume: true,
            paneRatios: { main: 8, volume: 2 },
          },
          metadata: null,
          priceReference: { previousClose: 10, referenceTime: null },
          availableIntervals: ["d"],
          density: "panel",
          status: "ready",
          historyError: false,
          hasMoreBefore: false,
          loadingMore: false,
          visible: true,
          onOptionsChange: vi.fn(),
          onRequestMore: vi.fn(),
          onRetry: vi.fn(),
        }),
      );
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const png = buttons.find(
      (button) => button.textContent === "data.chart.export.png",
    );
    const csv = buttons.find(
      (button) => button.textContent === "data.chart.export.csv",
    );

    await act(async () => png?.click());
    expect(mocks.takeScreenshot).toHaveBeenCalledOnce();
    expect(mocks.downloadChartPng).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      "chart-000001.SZSE-d.png",
    );

    act(() => csv?.click());
    expect(mocks.buildMarketBarsCsv).toHaveBeenCalledWith(bars);
    expect(mocks.downloadChartBlob).toHaveBeenCalledWith(
      expect.any(Blob),
      "chart-000001.SZSE-d.csv",
    );

    mocks.takeScreenshot.mockReturnValueOnce(null);
    act(() => png?.click());
    expect(mocks.toastError).toHaveBeenCalledWith(
      "data.chart.export.pngFailed",
    );

    mocks.downloadChartBlob.mockImplementationOnce(() => {
      throw new Error("blob-url-unavailable");
    });
    act(() => csv?.click());
    expect(mocks.toastError).toHaveBeenCalledWith(
      "data.chart.export.csvFailed",
    );
  });

  it("工作台按需加载指标管理并让统一十字线快照更新 legend", async () => {
    const onStudiesChange = vi.fn();
    const study = {
      instanceId: "sma-1",
      type: "sma" as const,
      params: { period: 20 },
      visible: true,
      styles: { line: { color: "#e0a43c", lineWidth: 2 as const } },
    };
    act(() => {
      root?.render(
        createElement(FinancialChartFrame, {
          bars: [marketBar("2026-07-30", 10, 11)],
          dataKey: "000001.SZSE|d|forward",
          symbol: "000001.SZSE",
          options: {
            interval: "d",
            adjust: "forward",
            chartType: "candlestick",
            showVolume: true,
            paneRatios: { main: 8, volume: 2 },
          },
          metadata: null,
          priceReference: { previousClose: 10, referenceTime: null },
          availableIntervals: ["d"],
          density: "panel",
          status: "ready",
          historyError: false,
          hasMoreBefore: false,
          loadingMore: false,
          visible: true,
          studies: [study],
          studyResults: [
            {
              instanceId: "sma-1",
              pane: "main",
              outputs: [
                {
                  id: "line",
                  kind: "line",
                  points: [
                    {
                      time: { kind: "trading-day", date: "2026-07-30" },
                      value: 10.5,
                    },
                  ],
                },
              ],
              levels: [],
            },
          ],
          studyLoading: false,
          studyError: false,
          onOptionsChange: vi.fn(),
          onStudiesChange,
          onRequestMore: vi.fn(),
          onRetry: vi.fn(),
        }),
      );
    });

    expect(mocks.dialogProps).toBeNull();
    expect(container.textContent).toContain("10.5");
    const crosshair = mocks.chartProps?.onCrosshairChange as (
      bar: MarketBar | null,
      values: Record<string, Record<string, number | null>>,
    ) => void;
    act(() =>
      crosshair(marketBar("2026-07-30", 10, 11), {
        "sma-1": { line: 21.25 },
      }),
    );
    expect(container.textContent).toContain("21.25");

    const manage = container.querySelector<HTMLButtonElement>(
      '[aria-label="data.chart.studies.open"]',
    );
    await act(async () => {
      manage?.click();
      await Promise.resolve();
    });
    expect(mocks.dialogProps).toMatchObject({
      open: true,
      instances: [expect.objectContaining({ instanceId: "sma-1" })],
    });

    const hide = container.querySelector<HTMLButtonElement>(
      '[aria-label="data.chart.studies.actions.hide"]',
    );
    act(() => hide?.click());
    expect(onStudiesChange).toHaveBeenCalledWith([
      expect.objectContaining({ instanceId: "sma-1", visible: false }),
    ]);
  });

  it("对比 legend 复用统一十字线快照并保持失败状态局部可恢复", () => {
    const onComparisonsChange = vi.fn();
    const onRetryComparison = vi.fn();
    const bars = [marketBar("2026-07-30", 10, 11)];
    const comparisons = [
      { vtSymbol: "600000.SSE", color: "#d9a441" },
      { vtSymbol: "000300.SSE", color: "#a56de2" },
    ];
    const comparisonSeries = [
      {
        vtSymbol: "000001.SZSE",
        name: "平安银行",
        color: "#000000",
        points: [
          {
            time: { kind: "trading-day" as const, date: "2026-07-30" },
            value: 1,
          },
        ],
      },
      {
        vtSymbol: "600000.SSE",
        name: "浦发银行",
        color: "#d9a441",
        points: [
          {
            time: { kind: "trading-day" as const, date: "2026-07-30" },
            value: 2,
          },
        ],
      },
    ];
    act(() => {
      root?.render(
        createElement(FinancialChartFrame, {
          bars,
          dataKey: "000001.SZSE|d|forward",
          symbol: "000001.SZSE",
          options: {
            interval: "d",
            adjust: "forward",
            chartType: "candlestick",
            showVolume: true,
            paneRatios: { main: 8, volume: 2 },
          },
          metadata: null,
          priceReference: { previousClose: 10, referenceTime: null },
          availableIntervals: ["d"],
          density: "panel",
          status: "ready",
          historyError: false,
          hasMoreBefore: false,
          loadingMore: false,
          visible: true,
          comparisons,
          comparisonSeries,
          comparisonStates: [
            {
              ...comparisonSeries[1],
              status: "ready",
              partial: false,
            },
            {
              vtSymbol: "000300.SSE",
              name: "沪深300",
              color: "#a56de2",
              points: [],
              status: "error",
              partial: false,
            },
          ],
          onOptionsChange: vi.fn(),
          onComparisonsChange,
          onRetryComparison,
          onRequestMore: vi.fn(),
          onRetry: vi.fn(),
        }),
      );
    });

    expect(container.textContent).toContain("1.00%");
    expect(container.textContent).toContain("2.00%");
    const crosshair = mocks.chartProps?.onCrosshairChange as (
      bar: MarketBar,
      studies: Record<string, never>,
      values: Record<string, number | null>,
    ) => void;
    act(() => crosshair(bars[0], {}, { "000001.SZSE": 3, "600000.SSE": -4 }));
    expect(container.textContent).toContain("3.00%");
    expect(container.textContent).toContain("-4.00%");

    const retry = container.querySelector<HTMLButtonElement>(
      '[aria-label="data.chart.comparisons.actions.retry"]',
    );
    act(() => retry?.click());
    expect(onRetryComparison).toHaveBeenCalledWith("000300.SSE");
    const remove = container.querySelector<HTMLButtonElement>(
      '[data-alpha-comparison="600000.SSE"] [aria-label="data.chart.comparisons.actions.remove"]',
    );
    act(() => remove?.click());
    expect(onComparisonsChange).toHaveBeenCalledWith([
      { vtSymbol: "000300.SSE", color: "#a56de2" },
    ]);
    expect(mocks.chartProps?.comparisonSeries).toBe(comparisonSeries);
  });

  it("超过上限时在构造 CSV 前显示本地化错误", () => {
    const bars = [
      marketBar("2026-07-28", 9, 10),
      marketBar("2026-07-29", 10, 11),
      marketBar("2026-07-30", 11, 12),
    ];
    act(() => {
      root?.render(
        createElement(FinancialChartFrame, {
          bars,
          dataKey: "000001.SZSE|d|forward",
          symbol: "000001.SZSE",
          options: {
            interval: "d",
            adjust: "forward",
            chartType: "candlestick",
            showVolume: true,
            paneRatios: { main: 8, volume: 2 },
          },
          metadata: null,
          priceReference: { previousClose: 10, referenceTime: null },
          availableIntervals: ["d"],
          density: "panel",
          status: "ready",
          historyError: false,
          hasMoreBefore: false,
          loadingMore: false,
          visible: true,
          onOptionsChange: vi.fn(),
          onRequestMore: vi.fn(),
          onRetry: vi.fn(),
        }),
      );
    });
    const csv = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "data.chart.export.csv",
    );

    act(() => csv?.click());

    expect(mocks.buildMarketBarsCsv).not.toHaveBeenCalled();
    expect(mocks.downloadChartBlob).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "data.chart.export.tooManyBars",
    );
  });

  it("展示实时状态、切换入口并允许用户回到最新", () => {
    const onRealtimeEnabledChange = vi.fn();
    act(() => {
      root?.render(
        createElement(FinancialChartFrame, {
          bars: [marketBar("2026-07-30", 10, 11)],
          dataKey: "000001.SZSE|d|forward",
          symbol: "000001.SZSE",
          options: {
            interval: "d",
            adjust: "forward",
            chartType: "candlestick",
            showVolume: true,
            paneRatios: { main: 8, volume: 2 },
          },
          metadata: null,
          priceReference: { previousClose: 10, referenceTime: null },
          availableIntervals: ["d"],
          density: "panel",
          status: "ready",
          historyError: false,
          hasMoreBefore: false,
          loadingMore: false,
          visible: true,
          realtimeEnabled: true,
          realtimeState: { status: "live" },
          onRealtimeEnabledChange,
          onOptionsChange: vi.fn(),
          onRequestMore: vi.fn(),
          onRetry: vi.fn(),
        }),
      );
    });
    expect(container.textContent).toContain("data.chart.realtime.status.live");
    const disable = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "data.chart.realtime.disable",
    );
    act(() => disable?.click());
    expect(onRealtimeEnabledChange).toHaveBeenCalledWith(false);

    act(() => {
      const callback = mocks.chartProps?.onFollowingLatestChange as (
        following: boolean,
      ) => void;
      callback(false);
    });
    const returnToLatest = Array.from(
      container.querySelectorAll("button"),
    ).find(
      (button) => button.textContent === "data.chart.realtime.returnToLatest",
    );
    act(() => returnToLatest?.click());
    expect(mocks.returnToLatest).toHaveBeenCalledOnce();
  });
});
