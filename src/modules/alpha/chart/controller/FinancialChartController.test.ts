/**
 * 本文件测试公共金融图表 Controller 的生命周期和命令。
 * 重点锁定单实例、历史 prepend 补偿、尾部更新与左侧请求单飞。
 */

import type { FinancialChartPalette } from "@/modules/alpha/chart/model";
import type { MarketBar } from "@/modules/alpha/market/model";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const makeSeries = () => ({
    setData: vi.fn(),
    update: vi.fn(),
    applyOptions: vi.fn(),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
  });
  const series = [makeSeries(), makeSeries(), makeSeries(), makeSeries()];
  const timeScale = {
    getVisibleLogicalRange: vi.fn(),
    setVisibleLogicalRange: vi.fn(),
    fitContent: vi.fn(),
    subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
  };
  const panes = [{ setStretchFactor: vi.fn() }, { setStretchFactor: vi.fn() }];
  const chart = {
    addSeries: vi.fn(),
    panes: vi.fn(() => panes),
    timeScale: vi.fn(() => timeScale),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  };
  return {
    series,
    timeScale,
    panes,
    chart,
    createChart: vi.fn(() => chart),
  };
});

vi.mock("lightweight-charts", () => ({
  BarSeries: Symbol("BarSeries"),
  CandlestickSeries: Symbol("CandlestickSeries"),
  ColorType: { Solid: "solid" },
  HistogramSeries: Symbol("HistogramSeries"),
  LineSeries: Symbol("LineSeries"),
  createChart: mocks.createChart,
}));

import { FinancialChartController } from "@/modules/alpha/chart/controller/FinancialChartController";

const palette: FinancialChartPalette = {
  text: "#aaa",
  grid: "#222",
  border: "#333",
  crosshair: "#bbb",
  up: "#0f0",
  down: "#f00",
  line: "#00f",
};

function bar(date: string, close: number): MarketBar {
  return {
    time: { kind: "trading-day", date },
    open: 10,
    high: Math.max(11, close),
    low: Math.min(9, close),
    close,
    volume: 100,
    amount: 1_000,
    openInterest: null,
  };
}

function chartHost(): HTMLElement {
  return {
    clientWidth: 800,
    clientHeight: 400,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLElement;
}

describe("FinancialChartController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let seriesIndex = 0;
    mocks.chart.addSeries.mockImplementation(() => mocks.series[seriesIndex++]);
    mocks.timeScale.getVisibleLogicalRange.mockReturnValue({
      from: 10,
      to: 20,
    });
  });

  it("主题和图表类型变化不重建实例，销毁时清理监听器", () => {
    const host = chartHost();
    const controller = new FinancialChartController(host);

    controller.applyTheme(palette);
    controller.setChartType("line");
    controller.destroy();

    expect(mocks.createChart).toHaveBeenCalledOnce();
    expect(mocks.chart.applyOptions).toHaveBeenCalled();
    expect(mocks.chart.unsubscribeCrosshairMove).toHaveBeenCalledOnce();
    expect(
      mocks.timeScale.unsubscribeVisibleLogicalRangeChange,
    ).toHaveBeenCalledOnce();
    expect(host.removeEventListener).toHaveBeenCalledTimes(2);
    expect(mocks.chart.remove).toHaveBeenCalledOnce();
  });

  it("历史 prepend 后按新增数量补偿原逻辑范围", () => {
    const controller = new FinancialChartController(chartHost());
    const current = [bar("2026-07-29", 11), bar("2026-07-30", 12)];

    controller.setBars("000001.SZSE|d|forward", current);
    controller.setBars("000001.SZSE|d|forward", [
      bar("2026-07-28", 10),
      ...current,
    ]);

    expect(mocks.timeScale.setVisibleLogicalRange).toHaveBeenCalledWith({
      from: 11,
      to: 21,
    });
  });

  it("稳定前缀上的尾部修订使用 update 而不是 setData", () => {
    const controller = new FinancialChartController(chartHost());
    const current = [bar("2026-07-29", 11), bar("2026-07-30", 12)];
    controller.setBars("000001.SZSE|d|forward", current);
    const setDataCalls = mocks.series[0].setData.mock.calls.length;

    controller.setBars("000001.SZSE|d|forward", [
      current[0],
      bar("2026-07-30", 13),
    ]);

    expect(mocks.series[0].setData).toHaveBeenCalledTimes(setDataCalls);
    expect(mocks.series[0].update).toHaveBeenCalledOnce();
  });

  it("同一帧只应用最终尺寸且隐藏时不调度 resize", () => {
    vi.useFakeTimers();
    try {
      const controller = new FinancialChartController(chartHost());

      controller.resize(700, 350);
      controller.resize(900, 450);
      vi.runAllTimers();

      expect(mocks.chart.applyOptions).toHaveBeenLastCalledWith({
        width: 900,
        height: 450,
      });
      const visibleCalls = mocks.chart.applyOptions.mock.calls.length;

      controller.setVisible(false);
      controller.resize(1_000, 500);
      vi.runAllTimers();

      expect(mocks.chart.applyOptions).toHaveBeenCalledTimes(visibleCalls);
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("行情修订后把十字线信息更新为当前快照", () => {
    vi.useFakeTimers();
    try {
      const onCrosshairChange = vi.fn();
      const controller = new FinancialChartController(chartHost());
      controller.setCallbacks({ onCrosshairChange });
      controller.setBars("000001.SZSE|d|forward", [
        bar("2026-07-29", 11),
        bar("2026-07-30", 12),
      ]);
      const handler = mocks.chart.subscribeCrosshairMove.mock
        .calls[0][0] as (params: {
        time?: { year: number; month: number; day: number };
      }) => void;

      handler({ time: { year: 2026, month: 7, day: 30 } });
      vi.runAllTimers();
      expect(onCrosshairChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ close: 12 }),
      );

      controller.setBars("000001.SZSE|d|forward", [
        bar("2026-07-29", 11),
        bar("2026-07-30", 13),
      ]);
      vi.runAllTimers();

      expect(onCrosshairChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ close: 13 }),
      );
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("series 内部范围变化不会误触发历史请求", () => {
    const requestMore = vi.fn();
    const host = chartHost();
    const controller = new FinancialChartController(host);
    controller.setCallbacks({ onRequestMore: requestMore });
    controller.setHistoryState(true, false);
    const pointerHandler = vi
      .mocked(host.addEventListener)
      .mock.calls.find(
        ([type]) => type === "pointerdown",
      )?.[1] as EventListener;
    pointerHandler(new Event("pointerdown"));
    const handler = mocks.timeScale.subscribeVisibleLogicalRangeChange.mock
      .calls[0][0] as (range: { from: number; to: number }) => void;
    mocks.series[0].setData.mockImplementationOnce(() => {
      handler({ from: 0, to: 10 });
    });

    controller.setBars("000001.SZSE|d|forward", [bar("2026-07-30", 12)]);

    expect(requestMore).not.toHaveBeenCalled();
    controller.destroy();
  });

  it("同一历史边界只发起一个加载请求", () => {
    const requestMore = vi.fn();
    const host = chartHost();
    const controller = new FinancialChartController(host);
    controller.setCallbacks({ onRequestMore: requestMore });
    controller.setHistoryState(true, false);
    const handler = mocks.timeScale.subscribeVisibleLogicalRangeChange.mock
      .calls[0][0] as (range: { from: number; to: number }) => void;

    handler({ from: 10, to: 20 });
    expect(requestMore).not.toHaveBeenCalled();
    const pointerHandler = vi
      .mocked(host.addEventListener)
      .mock.calls.find(
        ([type]) => type === "pointerdown",
      )?.[1] as EventListener;
    pointerHandler(new Event("pointerdown"));
    handler({ from: 8, to: 18 });
    handler({ from: 6, to: 16 });

    expect(requestMore).toHaveBeenCalledOnce();
  });
});
