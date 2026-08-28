/**
 * 本文件测试公共金融图表 Controller 的生命周期和命令。
 * 重点锁定单实例、指标 series/pane、同步防环、统一十字线、实时尾部、历史加载、视图和截图不变量。
 */

import type {
  ChartComparisonSeries,
  ChartMarketMetadata,
  FinancialChartPalette,
} from "@/modules/alpha/chart/model";
import type {
  ChartStudyInstance,
  ChartStudyResult,
} from "@/modules/alpha/chart/studies/model";
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
  const studySeries: ReturnType<typeof makeSeries>[] = [];
  const timeScale = {
    getVisibleLogicalRange: vi.fn(),
    setVisibleLogicalRange: vi.fn(),
    setVisibleRange: vi.fn(),
    fitContent: vi.fn(),
    scrollToRealTime: vi.fn(),
    subscribeVisibleTimeRangeChange: vi.fn(),
    unsubscribeVisibleTimeRangeChange: vi.fn(),
    subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
  };
  const panes = Array.from({ length: 8 }, (_, index) => ({
    setStretchFactor: vi.fn(),
    getStretchFactor: vi.fn((): number => (index === 0 ? 8 : 2)),
  }));
  const chart = {
    addSeries: vi.fn(),
    removeSeries: vi.fn(),
    removePane: vi.fn(),
    panes: vi.fn(() => panes),
    timeScale: vi.fn(() => timeScale),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    setCrosshairPosition: vi.fn(),
    clearCrosshairPosition: vi.fn(),
    applyOptions: vi.fn(),
    takeScreenshot: vi.fn(() => ({ width: 800, height: 400 })),
    remove: vi.fn(),
  };
  return {
    series,
    studySeries,
    makeSeries,
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

function comparison(
  vtSymbol: string,
  color: string,
  values: Array<[date: string, value: number]>,
): ChartComparisonSeries {
  return {
    vtSymbol,
    name: vtSymbol,
    color,
    points: values.map(([date, value]) => ({
      time: { kind: "trading-day", date },
      value,
    })),
  };
}

function studyInstance(
  instanceId: string,
  type: "sma" | "rsi" | "macd",
): ChartStudyInstance {
  const outputIds = type === "macd" ? ["macd", "signal", "hist"] : ["line"];
  return {
    instanceId,
    type,
    params:
      type === "macd" ? { fast: 12, slow: 26, signal: 9 } : { period: 14 },
    visible: true,
    styles: Object.fromEntries(
      outputIds.map((outputId) => [
        outputId,
        { color: "#abcdef", lineWidth: 2 as const },
      ]),
    ),
  };
}

function studyResult(
  instanceId: string,
  pane: "main" | "separate",
  outputIds: string[],
): ChartStudyResult {
  return {
    instanceId,
    pane,
    outputs: outputIds.map((outputId) => ({
      id: outputId,
      kind: outputId === "hist" ? "histogram" : "line",
      points: [
        { time: { kind: "trading-day", date: "2026-07-29" }, value: -1 },
        { time: { kind: "trading-day", date: "2026-07-30" }, value: 1 },
      ],
    })),
    levels: pane === "separate" ? [0] : [],
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
    mocks.studySeries.length = 0;
    let seriesIndex = 0;
    mocks.chart.addSeries.mockImplementation(() => {
      if (seriesIndex < mocks.series.length) return mocks.series[seriesIndex++];
      const created = mocks.makeSeries();
      mocks.studySeries.push(created);
      return created;
    });
    mocks.panes.forEach((pane, index) => {
      pane.getStretchFactor.mockReturnValue(index === 0 ? 8 : 2);
    });
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

  it("没有指标时不创建 series，也不重排既有 pane", () => {
    const controller = new FinancialChartController(chartHost());

    controller.setStudies([], []);

    expect(mocks.chart.addSeries).toHaveBeenCalledTimes(4);
    expect(mocks.chart.removePane).not.toHaveBeenCalled();
    expect(mocks.series[3].moveToPane).not.toHaveBeenCalled();
  });

  it("没有对比配置时不创建 series 或重复应用图表选项", () => {
    const controller = new FinancialChartController(chartHost());
    const optionCalls = mocks.chart.applyOptions.mock.calls.length;

    controller.setComparisons(null, []);

    expect(mocks.chart.addSeries).toHaveBeenCalledTimes(4);
    expect(mocks.chart.applyOptions).toHaveBeenCalledTimes(optionCalls);
  });

  it("按标的复用对比线、保持右价格轴并在清空后隐藏左轴", () => {
    const controller = new FinancialChartController(chartHost());
    const main = comparison("MAIN.SSE", "#000000", [
      ["2026-07-29", 0],
      ["2026-07-30", 10],
    ]);
    const peer = comparison("PEER.SSE", "#d9a441", [
      ["2026-07-29", 0],
      ["2026-07-30", -5],
    ]);

    controller.applyTheme(palette);
    controller.setComparisons("MAIN.SSE", [main, peer]);
    const createdCount = mocks.chart.addSeries.mock.calls.length;
    const mainLine = mocks.studySeries[0];
    const peerLine = mocks.studySeries[1];

    expect(mainLine.applyOptions).toHaveBeenLastCalledWith({
      color: palette.line,
    });
    expect(peerLine.applyOptions).toHaveBeenLastCalledWith({
      color: "#d9a441",
    });
    expect(mocks.chart.applyOptions).toHaveBeenLastCalledWith({
      leftPriceScale: {
        visible: true,
        borderVisible: true,
        borderColor: palette.border,
      },
    });

    controller.setComparisons("MAIN.SSE", [
      main,
      { ...peer, color: "#a56de2" },
    ]);
    expect(mocks.chart.addSeries).toHaveBeenCalledTimes(createdCount);
    expect(peerLine.applyOptions).toHaveBeenLastCalledWith({
      color: "#a56de2",
    });

    controller.setComparisons(null, []);
    expect(mocks.chart.removeSeries).toHaveBeenCalledWith(mainLine);
    expect(mocks.chart.removeSeries).toHaveBeenCalledWith(peerLine);
    expect(mocks.chart.applyOptions).toHaveBeenLastCalledWith({
      leftPriceScale: {
        visible: false,
        borderVisible: false,
        borderColor: palette.border,
      },
    });
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
    mocks.panes[0].getStretchFactor.mockReturnValue(7);
    mocks.panes[1].getStretchFactor.mockReturnValue(3);
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
    expect(controller.getPaneRatios()).toEqual({ main: 7, volume: 3 });
  });

  it("增量复用 study series 并按成交量、指标顺序重建 pane", () => {
    const controller = new FinancialChartController(chartHost());
    const instances = [
      studyInstance("sma-1", "sma"),
      studyInstance("rsi-1", "rsi"),
      studyInstance("macd-1", "macd"),
    ];
    const results = [
      studyResult("sma-1", "main", ["line"]),
      studyResult("rsi-1", "separate", ["line"]),
      studyResult("macd-1", "separate", ["macd", "signal", "hist"]),
    ];

    controller.setStudies(results, instances);
    const createdCount = mocks.chart.addSeries.mock.calls.length;

    expect(mocks.studySeries).toHaveLength(5);
    expect(mocks.studySeries[0].moveToPane).not.toHaveBeenCalled();
    expect(mocks.studySeries[1].moveToPane).toHaveBeenLastCalledWith(2);
    for (const series of mocks.studySeries.slice(2)) {
      expect(series.moveToPane).toHaveBeenLastCalledWith(3);
    }

    controller.setStudies(results, [instances[2], instances[1], instances[0]]);

    expect(mocks.chart.addSeries).toHaveBeenCalledTimes(createdCount);
    for (const series of mocks.studySeries.slice(2)) {
      expect(series.moveToPane).toHaveBeenLastCalledWith(2);
    }
    expect(mocks.studySeries[1].moveToPane).toHaveBeenLastCalledWith(3);
  });

  it("隐藏指标移除 series，成交量隐藏后独立 pane 自动前移", () => {
    const controller = new FinancialChartController(chartHost());
    const rsi = studyInstance("rsi-1", "rsi");
    const macd = studyInstance("macd-1", "macd");
    const results = [
      studyResult("rsi-1", "separate", ["line"]),
      studyResult("macd-1", "separate", ["macd", "signal", "hist"]),
    ];
    controller.setStudies(results, [rsi, macd]);

    controller.setStudies([results[1]], [{ ...rsi, visible: false }, macd]);
    expect(mocks.chart.removeSeries).toHaveBeenCalledWith(mocks.studySeries[0]);

    controller.setShowVolume(false);
    for (const series of mocks.studySeries.slice(1)) {
      expect(series.moveToPane).toHaveBeenLastCalledWith(1);
    }
  });

  it("为独立指标创建低强调水平线并按正负值着色 histogram", () => {
    const controller = new FinancialChartController(chartHost());
    controller.applyTheme(palette);
    const macd = studyInstance("macd-1", "macd");

    controller.setStudies(
      [studyResult("macd-1", "separate", ["macd", "signal", "hist"])],
      [macd],
    );

    expect(mocks.studySeries[0].createPriceLine).toHaveBeenCalledWith(
      expect.objectContaining({
        price: 0,
        color: palette.grid,
        axisLabelVisible: false,
      }),
    );
    expect(mocks.studySeries[2].setData).toHaveBeenCalledWith([
      expect.objectContaining({ value: -1, color: palette.down }),
      expect.objectContaining({ value: 1, color: palette.up }),
    ]);
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

  it("只在启用范围同步时监听实际时间，并阻止同步命令回传和加载历史", () => {
    vi.useFakeTimers();
    try {
      const onVisibleTimeRangeChange = vi.fn();
      const onRequestMore = vi.fn();
      const host = chartHost();
      const controller = new FinancialChartController(host);
      expect(
        mocks.timeScale.subscribeVisibleTimeRangeChange,
      ).not.toHaveBeenCalled();
      controller.setCallbacks({ onVisibleTimeRangeChange, onRequestMore });
      controller.setBars("000001.SZSE|d|forward", [
        bar("2026-07-29", 11),
        bar("2026-07-30", 12),
      ]);
      controller.setHistoryState(true, false);
      const pointerHandler = vi
        .mocked(host.addEventListener)
        .mock.calls.find(
          ([type]) => type === "pointerdown",
        )?.[1] as EventListener;
      pointerHandler(new Event("pointerdown"));
      const timeHandler = mocks.timeScale.subscribeVisibleTimeRangeChange.mock
        .calls[0][0] as (range: {
        from: { year: number; month: number; day: number };
        to: { year: number; month: number; day: number };
      }) => void;
      const logicalHandler = mocks.timeScale.subscribeVisibleLogicalRangeChange
        .mock.calls[0][0] as (range: { from: number; to: number }) => void;

      timeHandler({
        from: { year: 2026, month: 7, day: 1 },
        to: { year: 2026, month: 7, day: 30 },
      });
      expect(onVisibleTimeRangeChange).toHaveBeenCalledWith({
        from: { kind: "trading-day", date: "2026-07-01" },
        to: { kind: "trading-day", date: "2026-07-30" },
      });

      mocks.timeScale.setVisibleRange.mockImplementationOnce((range) => {
        timeHandler(range);
        logicalHandler({ from: 0, to: 10 });
      });
      controller.setVisibleTimeRangeFromSync({
        from: { kind: "trading-day", date: "2026-07-29" },
        to: { kind: "trading-day", date: "2026-07-30" },
      });

      expect(mocks.timeScale.setVisibleRange).toHaveBeenCalledWith({
        from: { year: 2026, month: 7, day: 29 },
        to: { year: 2026, month: 7, day: 30 },
      });
      expect(onVisibleTimeRangeChange).toHaveBeenCalledOnce();
      expect(onRequestMore).not.toHaveBeenCalled();
      vi.runAllTimers();

      controller.setCallbacks({ onRequestMore });
      expect(
        mocks.timeScale.unsubscribeVisibleTimeRangeChange,
      ).toHaveBeenCalledOnce();
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("十字线同步复用现有订阅、精确使用本地价格并让本地 pointer 优先", () => {
    vi.useFakeTimers();
    try {
      const onCrosshairTimeChange = vi.fn();
      const onCrosshairChange = vi.fn();
      const host = chartHost();
      const controller = new FinancialChartController(host);
      const first = bar("2026-07-29", 11);
      const second = bar("2026-07-30", 12);
      controller.setBars("000001.SZSE|d|forward", [first, second]);
      const sma = studyInstance("sma-1", "sma");
      controller.setStudies([studyResult("sma-1", "main", ["line"])], [sma]);
      controller.setCallbacks({ onCrosshairChange, onCrosshairTimeChange });
      const pointerEnter = vi
        .mocked(host.addEventListener)
        .mock.calls.find(
          ([type]) => type === "pointerenter",
        )?.[1] as EventListener;
      const pointerLeave = vi
        .mocked(host.addEventListener)
        .mock.calls.find(
          ([type]) => type === "pointerleave",
        )?.[1] as EventListener;
      const handler = mocks.chart.subscribeCrosshairMove.mock
        .calls[0][0] as (params: {
        time?: { year: number; month: number; day: number };
        seriesData: Map<unknown, { value: number }>;
      }) => void;
      mocks.chart.setCrosshairPosition.mockImplementationOnce(
        (_price, time) => {
          handler({ time, seriesData: new Map() });
        },
      );

      pointerEnter(new Event("pointerenter"));
      handler({
        time: { year: 2026, month: 7, day: 29 },
        seriesData: new Map(),
      });
      expect(onCrosshairTimeChange).toHaveBeenLastCalledWith(first.time);

      controller.setCrosshairFromSync(second.time, second);
      expect(mocks.chart.setCrosshairPosition).not.toHaveBeenCalled();

      pointerLeave(new Event("pointerleave"));
      expect(onCrosshairTimeChange).toHaveBeenLastCalledWith(null);
      expect(mocks.chart.setCrosshairPosition).toHaveBeenCalledWith(
        12,
        { year: 2026, month: 7, day: 30 },
        mocks.series[0],
      );
      expect(onCrosshairTimeChange).toHaveBeenCalledTimes(2);
      vi.runAllTimers();
      expect(onCrosshairChange).toHaveBeenLastCalledWith(
        second,
        {
          "sma-1": { line: 1 },
        },
        {},
      );

      controller.setCrosshairFromSync(
        { kind: "trading-day", date: "2026-07-31" },
        null,
      );
      expect(mocks.chart.clearCrosshairPosition).toHaveBeenCalledOnce();
      expect(mocks.chart.subscribeCrosshairMove).toHaveBeenCalledOnce();
      vi.runAllTimers();
      expect(onCrosshairChange).toHaveBeenLastCalledWith(null, {}, {});
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
        seriesData: Map<unknown, { value: number }>;
      }) => void;

      handler({
        time: { year: 2026, month: 7, day: 30 },
        seriesData: new Map(),
      });
      vi.runAllTimers();
      expect(onCrosshairChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ close: 12 }),
        {},
        {},
      );

      controller.setBars("000001.SZSE|d|forward", [
        bar("2026-07-29", 11),
        bar("2026-07-30", 13),
      ]);
      vi.runAllTimers();

      expect(onCrosshairChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ close: 13 }),
        {},
        {},
      );
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("单个十字线订阅在同一帧提交行情和全部指标值", () => {
    vi.useFakeTimers();
    try {
      const onCrosshairChange = vi.fn();
      const controller = new FinancialChartController(chartHost());
      controller.setCallbacks({ onCrosshairChange });
      controller.setBars("000001.SZSE|d|forward", [bar("2026-07-30", 12)]);
      const sma = studyInstance("sma-1", "sma");
      controller.setStudies([studyResult("sma-1", "main", ["line"])], [sma]);
      controller.setComparisons("000001.SZSE", [
        comparison("000001.SZSE", "#000000", [["2026-07-30", 4]]),
        comparison("600000.SSE", "#d9a441", [["2026-07-30", -2]]),
      ]);
      const handler = mocks.chart.subscribeCrosshairMove.mock
        .calls[0][0] as (params: {
        time?: { year: number; month: number; day: number };
        seriesData: Map<unknown, { value: number }>;
      }) => void;

      handler({
        time: { year: 2026, month: 7, day: 30 },
        seriesData: new Map([
          [mocks.studySeries[0], { value: 21.5 }],
          [mocks.studySeries[1], { value: 4 }],
          [mocks.studySeries[2], { value: -2 }],
        ]),
      });
      handler({
        time: { year: 2026, month: 7, day: 30 },
        seriesData: new Map([
          [mocks.studySeries[0], { value: 22 }],
          [mocks.studySeries[1], { value: 4.5 }],
          [mocks.studySeries[2], { value: -1.5 }],
        ]),
      });
      vi.runAllTimers();

      expect(mocks.chart.subscribeCrosshairMove).toHaveBeenCalledOnce();
      expect(onCrosshairChange).toHaveBeenCalledOnce();
      expect(onCrosshairChange).toHaveBeenCalledWith(
        expect.objectContaining({ close: 12 }),
        { "sma-1": { line: 22 } },
        { "000001.SZSE": 4.5, "600000.SSE": -1.5 },
      );
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

  it("实时同 bucket 只更新尾部，新 bucket 在跟随状态滚到最新", () => {
    const latest = vi.fn();
    const controller = new FinancialChartController(chartHost());
    controller.setCallbacks({ onLatestBarChange: latest });
    controller.setBars("000001.SZSE|d|forward", [bar("2026-07-30", 10)]);
    mocks.series.forEach((series) => {
      series.update.mockClear();
    });
    mocks.timeScale.scrollToRealTime.mockClear();

    expect(
      controller.updateLiveBar("000001.SZSE|d|forward", bar("2026-07-30", 11)),
    ).toBe(true);
    expect(mocks.series[0].update).toHaveBeenCalledOnce();
    expect(mocks.timeScale.scrollToRealTime).not.toHaveBeenCalled();

    expect(
      controller.updateLiveBar("000001.SZSE|d|forward", bar("2026-07-31", 12)),
    ).toBe(true);
    expect(mocks.timeScale.scrollToRealTime).toHaveBeenCalledOnce();
    expect(latest).toHaveBeenLastCalledWith(
      expect.objectContaining({ close: 12 }),
    );
    expect(
      controller.updateLiveBar("OTHER.SSE|d|forward", bar("2026-08-01", 13)),
    ).toBe(false);
  });

  it("HTTP 快照已包含实时尾部时允许重叠重校准", () => {
    const controller = new FinancialChartController(chartHost());
    const initial = [bar("2026-05-15", 10.99)];
    const snapshot = [
      ...initial,
      bar("2026-08-27", 11.59),
      bar("2026-08-28", 11.65),
    ];
    controller.setBars("000001.SZSE|d|forward", initial);
    controller.setRealtimeSnapshot("000001.SZSE|d|forward", snapshot);

    expect(() =>
      controller.setBars("000001.SZSE|d|forward", snapshot),
    ).not.toThrow();
    expect(mocks.series[0].setData).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ close: 11.65 })]),
    );
  });

  it("离开尾部后不抢 viewport，用户可主动回到最新", () => {
    const following = vi.fn();
    const host = chartHost();
    const controller = new FinancialChartController(host);
    controller.setCallbacks({ onFollowingLatestChange: following });
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
    rangeHandler({ from: 2, to: 10 });
    expect(controller.isFollowingLatest()).toBe(false);
    mocks.timeScale.scrollToRealTime.mockClear();

    controller.updateLiveBar("000001.SZSE|d|forward", bar("2026-08-01", 21));
    expect(mocks.timeScale.scrollToRealTime).not.toHaveBeenCalled();

    controller.returnToLatest();
    expect(controller.isFollowingLatest()).toBe(true);
    expect(mocks.timeScale.scrollToRealTime).toHaveBeenCalledOnce();
    expect(following.mock.calls.map(([value]) => value)).toEqual([false, true]);
  });

  it("截图明确排除顶层和十字线", () => {
    const controller = new FinancialChartController(chartHost());

    expect(controller.takeScreenshot()).toEqual({ width: 800, height: 400 });
    expect(mocks.chart.takeScreenshot).toHaveBeenCalledOnce();
    expect(mocks.chart.takeScreenshot).toHaveBeenCalledWith(false, false);
  });
});
