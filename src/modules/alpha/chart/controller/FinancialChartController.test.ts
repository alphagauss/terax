/**
 * 本文件测试公共金融图表 Controller 的生命周期和命令。
 * 重点锁定单实例、署名配置、历史加载、平移边界和视图重置不变量。
 */

import type {
  ChartMarketMetadata,
  FinancialChartPalette,
} from "@/modules/alpha/chart/model";
import type { MarketBar } from "@/modules/alpha/market/model";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const makeSeries = () => {
    const priceScaleApi = { applyOptions: vi.fn() };
    const priceLine = {};
    return {
      setData: vi.fn(),
      update: vi.fn(),
      applyOptions: vi.fn(),
      priceScale: vi.fn(() => priceScaleApi),
      createPriceLine: vi.fn(() => priceLine),
      removePriceLine: vi.fn(),
      moveToPane: vi.fn(),
      priceScaleApi,
      priceLine,
    };
  };
  const series = [makeSeries(), makeSeries(), makeSeries(), makeSeries()];
  const timeScale = {
    getVisibleLogicalRange: vi.fn(),
    setVisibleLogicalRange: vi.fn(),
    fitContent: vi.fn(),
    subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
  };
  const panes = [
    { setStretchFactor: vi.fn(), getStretchFactor: vi.fn(() => 8) },
    { setStretchFactor: vi.fn(), getStretchFactor: vi.fn(() => 2) },
  ];
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
  LineStyle: { Dashed: 2, Dotted: 1 },
  LineSeries: Symbol("LineSeries"),
  TickMarkType: {
    Year: 0,
    Month: 1,
    DayOfMonth: 2,
    Time: 3,
    TimeWithSeconds: 4,
  },
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

const metadata: ChartMarketMetadata = {
  vtSymbol: "000001.SZSE",
  name: "平安银行",
  exchange: "SZSE",
  timezone: "Asia/Shanghai",
  minMove: 0.05,
  pricePrecision: 2,
  volumeUnit: "share",
  priceColorConvention: "up-red",
  intervals: ["1m", "d"],
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
    expect(mocks.createChart).toHaveBeenCalledWith(
      host,
      expect.objectContaining({
        layout: expect.objectContaining({ attributionLogo: false }),
      }),
    );
    expect(mocks.chart.applyOptions).toHaveBeenCalled();
    expect(mocks.chart.unsubscribeCrosshairMove).toHaveBeenCalledOnce();
    expect(
      mocks.timeScale.unsubscribeVisibleLogicalRangeChange,
    ).toHaveBeenCalledOnce();
    expect(host.removeEventListener).toHaveBeenCalledTimes(2);
    expect(mocks.chart.remove).toHaveBeenCalledOnce();
  });

  it("应用价格精度和交易所时区时不重建 series", () => {
    const controller = new FinancialChartController(chartHost());

    controller.setMarketMetadata(metadata, "zh-CN");

    for (const series of mocks.series.slice(0, 3)) {
      expect(series.applyOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          priceFormat: { type: "price", precision: 2, minMove: 0.05 },
        }),
      );
    }
    expect(mocks.chart.applyOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        localization: expect.objectContaining({ locale: "zh-CN" }),
        timeScale: expect.objectContaining({
          tickMarkFormatter: expect.any(Function),
        }),
      }),
    );
    expect(mocks.chart.addSeries).toHaveBeenCalledTimes(4);
  });

  it("创建、替换和移除权威昨收线，并把零视为有效参考价", () => {
    const controller = new FinancialChartController(chartHost());

    controller.setPriceReference(
      {
        previousClose: 0,
        referenceTime: { kind: "trading-day", date: "2026-07-29" },
      },
      "昨收",
    );
    expect(mocks.series[0].createPriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ price: 0, title: "昨收" }),
    );

    controller.setChartType("line");
    expect(mocks.series[0].removePriceLine).toHaveBeenCalledOnce();
    expect(mocks.series[2].createPriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ price: 0, title: "昨收" }),
    );

    controller.setPriceReference(
      { previousClose: null, referenceTime: null },
      "昨收",
    );
    expect(mocks.series[2].removePriceLine).toHaveBeenCalledOnce();
  });

  it("隐藏成交量时移入主 pane，恢复时重建辅助 pane 和用户比例", () => {
    const controller = new FinancialChartController(chartHost());

    controller.setPaneRatios({ main: 7, volume: 3 });
    controller.setShowVolume(false);
    expect(mocks.series[3].applyOptions).toHaveBeenLastCalledWith({
      visible: false,
    });
    expect(mocks.series[3].moveToPane).toHaveBeenLastCalledWith(0);

    controller.setShowVolume(true);
    expect(mocks.series[3].moveToPane).toHaveBeenLastCalledWith(1);
    expect(mocks.series[3].applyOptions).toHaveBeenLastCalledWith({
      visible: true,
    });
    expect(mocks.panes[0].setStretchFactor).toHaveBeenLastCalledWith(7);
    expect(mocks.panes[1].setStretchFactor).toHaveBeenLastCalledWith(3);
    expect(controller.getPaneRatios()).toEqual({ main: 8, volume: 2 });
  });

  it("图表过矮时临时使用主 pane 优先比例且不覆盖用户配置", () => {
    vi.useFakeTimers();
    try {
      const controller = new FinancialChartController(chartHost());
      controller.setPaneRatios({ main: 6, volume: 4 });
      mocks.panes[0].setStretchFactor.mockClear();
      mocks.panes[1].setStretchFactor.mockClear();

      controller.resize(600, 180);
      vi.runAllTimers();

      expect(mocks.panes[0].setStretchFactor).toHaveBeenLastCalledWith(8);
      expect(mocks.panes[1].setStretchFactor).toHaveBeenLastCalledWith(2);
      expect(controller.getPaneRatios()).toEqual({ main: 6, volume: 4 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("最新价线颜色使用权威昨收和当前市场 palette", () => {
    const controller = new FinancialChartController(chartHost());
    controller.setPriceReference(
      {
        previousClose: 10,
        referenceTime: { kind: "trading-day", date: "2026-07-29" },
      },
      "昨收",
    );
    controller.setBars("000001.SZSE|d|forward", [bar("2026-07-30", 11)]);
    controller.applyTheme(palette);

    for (const series of mocks.series.slice(0, 3)) {
      expect(series.applyOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          priceLineVisible: true,
          lastValueVisible: true,
          priceLineColor: palette.up,
        }),
      );
    }
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

  it("用户平移越过数据两端时保留八根可见 K 线", () => {
    const host = chartHost();
    const controller = new FinancialChartController(host);
    controller.setBars(
      "000001.SZSE|d|forward",
      Array.from({ length: 20 }, (_, index) =>
        bar(`2026-07-${String(index + 1).padStart(2, "0")}`, index + 1),
      ),
    );
    const pointerHandler = vi
      .mocked(host.addEventListener)
      .mock.calls.find(
        ([type]) => type === "pointerdown",
      )?.[1] as EventListener;
    const rangeHandler = mocks.timeScale.subscribeVisibleLogicalRangeChange.mock
      .calls[0][0] as (range: { from: number; to: number }) => void;
    pointerHandler(new Event("pointerdown"));

    rangeHandler({ from: 30, to: 40 });
    expect(mocks.timeScale.setVisibleLogicalRange).toHaveBeenLastCalledWith({
      from: 12,
      to: 22,
    });

    rangeHandler({ from: -20, to: -10 });
    expect(mocks.timeScale.setVisibleLogicalRange).toHaveBeenLastCalledWith({
      from: -3,
      to: 7,
    });
  });

  it("重置视图恢复价格自动缩放并适配全部内容", () => {
    const controller = new FinancialChartController(chartHost());
    controller.setBars("000001.SZSE|d|forward", [bar("2026-07-30", 12)]);
    mocks.series[0].priceScaleApi.applyOptions.mockClear();
    mocks.timeScale.fitContent.mockClear();

    controller.resetView();

    expect(mocks.series[0].priceScaleApi.applyOptions).toHaveBeenCalledWith({
      autoScale: true,
    });
    expect(mocks.timeScale.fitContent).toHaveBeenCalledOnce();
  });
});
