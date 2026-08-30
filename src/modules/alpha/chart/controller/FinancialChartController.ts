/**
 * 本文件封装 Alpha 公共金融图表的 Lightweight Charts 运行时。
 * Controller 独占实例、价格、指标与对比 series、动态 pane、监听器、同步命令、viewport 和截图命令，不执行查询或持久化。
 */

import {
  buildFinancialSeriesData,
  countPrependedBars,
  financialChartTime,
  financialTailUpdateMode,
} from "@/modules/alpha/chart/lightweight/data";
import {
  buildChartStudySeriesData,
  type RoutedChartStudy,
  routeChartStudies,
} from "@/modules/alpha/chart/lightweight/studies";
import type {
  ChartComparisonLegendValues,
  ChartComparisonSeries,
  ChartMarketMetadata,
  ChartPriceReference,
  FinancialChartPalette,
  FinancialChartType,
  PaneRatios,
} from "@/modules/alpha/chart/model";
import { createRafBatcher } from "@/modules/alpha/chart/rafBatcher";
import type {
  ChartStudyInstance,
  ChartStudyResult,
  ChartStudySeriesKind,
} from "@/modules/alpha/chart/studies/model";
import type { ChartTimeRange } from "@/modules/alpha/chart/sync/ChartSyncContext";
import { formatMarketTimestamp } from "@/modules/alpha/market/metadata";
import type { MarketBar, MarketTime } from "@/modules/alpha/market/model";
import {
  marketTimeKey,
  mergeMarketBarTail,
} from "@/modules/alpha/market/normalize";
import {
  BarSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type IRange,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  type Logical,
  type LogicalRange,
  type MouseEventParams,
  TickMarkType,
  type Time,
} from "lightweight-charts";

const HISTORY_LOAD_THRESHOLD = 20;
const MIN_VISIBLE_BARS_AFTER_PAN = 8;
const DEFAULT_PANE_RATIOS: PaneRatios = { main: 8, volume: 2 };
const MIN_CUSTOM_PANE_HEIGHT = 240;

type ChartCallbacks = {
  onCrosshairChange?: (
    bar: MarketBar | null,
    studyValues: ChartStudyLegendValues,
    comparisonValues: ChartComparisonLegendValues,
  ) => void;
  onVisibleTimeRangeChange?: (range: ChartTimeRange) => void;
  onCrosshairTimeChange?: (time: MarketTime | null) => void;
  onRequestMore?: () => void;
  onLatestBarChange?: (bar: MarketBar) => void;
  onFollowingLatestChange?: (following: boolean) => void;
};

export type ChartStudyLegendValues = Record<
  string,
  Record<string, number | null>
>;

type StudySeriesApi = ISeriesApi<"Line" | "Histogram">;

type StudyRuntime = {
  instanceId: string;
  pane: "main" | "separate";
  paneIndex: number;
  outputs: Map<string, { kind: ChartStudySeriesKind; series: StudySeriesApi }>;
  levelLines: Array<{ line: IPriceLine; series: StudySeriesApi }>;
};

type CrosshairSnapshot = {
  bar: MarketBar | null;
  studyValues: ChartStudyLegendValues;
  comparisonValues: ChartComparisonLegendValues;
};

type ComparisonRuntime = {
  item: ChartComparisonSeries;
  series: ISeriesApi<"Line">;
};

const DEFAULT_PALETTE: FinancialChartPalette = {
  text: "#9d9d9d",
  grid: "#2b2b2b",
  border: "#2b2b2b",
  crosshair: "#9d9d9d",
  up: "#73c991",
  down: "#f85149",
  line: "#4daafc",
};

function chartTimeKey(time: Time): string {
  if (typeof time === "object") {
    return `${time.year}-${time.month}-${time.day}`;
  }
  return String(time);
}

/** 将图表引擎时间还原为公共行情时间，拒绝本项目不会写入 series 的字符串时间。 */
function marketTimeFromChartTime(time: Time): MarketTime | null {
  if (typeof time === "number") {
    return { kind: "instant", epochSeconds: time };
  }
  if (typeof time === "string") return null;
  return {
    kind: "trading-day",
    date: `${time.year}-${String(time.month).padStart(2, "0")}-${String(
      time.day,
    ).padStart(2, "0")}`,
  };
}

/** 管理单个公共金融图表实例及其命令。 */
export class FinancialChartController {
  private readonly host: HTMLElement;
  private readonly chart: IChartApi;
  private readonly candles: ISeriesApi<"Candlestick">;
  private readonly ohlc: ISeriesApi<"Bar">;
  private readonly line: ISeriesApi<"Line">;
  private readonly volume: ISeriesApi<"Histogram">;
  private readonly resizeBatcher: ReturnType<
    typeof createRafBatcher<{ width: number; height: number }>
  >;
  private readonly crosshairBatcher: ReturnType<
    typeof createRafBatcher<CrosshairSnapshot>
  >;
  private callbacks: ChartCallbacks = {};
  private palette = DEFAULT_PALETTE;
  private chartType: FinancialChartType = "candlestick";
  private priceReference: ChartPriceReference = {
    previousClose: null,
    referenceTime: null,
  };
  private previousCloseTitle = "";
  private previousCloseLine: IPriceLine | null = null;
  private previousCloseSeries: ISeriesApi<
    "Candlestick" | "Bar" | "Line"
  > | null = null;
  private showVolume = true;
  private paneRatios: PaneRatios = { ...DEFAULT_PANE_RATIOS };
  private chartHeight: number;
  private bars: readonly MarketBar[] = [];
  private stableBars: readonly MarketBar[] = [];
  private liveTail: MarketBar[] = [];
  private barsByTime = new Map<string, MarketBar>();
  private dataKey = "";
  private visible = true;
  private hasMoreBefore = false;
  private loadingMore = false;
  private requestPending = false;
  private chartMutationInProgress = false;
  private visibleTimeRangeSubscribed = false;
  private syncRangeMutationInProgress = false;
  private syncRangeReleaseBatcher: ReturnType<
    typeof createRafBatcher<null>
  > | null = null;
  private syncCrosshairMutationInProgress = false;
  private crosshairPointerSubscribed = false;
  private localCrosshairActive = false;
  private pendingCrosshairSync: {
    time: MarketTime | null;
    localBar: MarketBar | null;
  } | null = null;
  private crosshairTimeKey: string | null = null;
  private historyInteractionArmed = false;
  private followingLatest = true;
  private studyInstances: readonly ChartStudyInstance[] = [];
  private studyResults: readonly ChartStudyResult[] = [];
  private studyPaneSignature = "";
  private studyRuntimes = new Map<string, StudyRuntime>();
  private studySeriesMetadata = new Map<
    StudySeriesApi,
    { instanceId: string; outputId: string }
  >();
  private crosshairStudyValues: ChartStudyLegendValues = {};
  private mainComparisonVtSymbol: string | null = null;
  private comparisonSeries: readonly ChartComparisonSeries[] = [];
  private comparisonRuntimes = new Map<string, ComparisonRuntime>();
  private comparisonSeriesMetadata = new Map<ISeriesApi<"Line">, string>();
  private crosshairComparisonValues: ChartComparisonLegendValues = {};

  constructor(host: HTMLElement) {
    this.host = host;
    this.chartHeight = Math.max(1, host.clientHeight);
    this.chart = createChart(host, {
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        attributionLogo: false,
      },
      timeScale: { borderVisible: false },
      leftPriceScale: { visible: false, borderVisible: false },
      rightPriceScale: { borderVisible: false },
    });
    this.candles = this.chart.addSeries(CandlestickSeries, {}, 0);
    this.ohlc = this.chart.addSeries(BarSeries, { visible: false }, 0);
    this.line = this.chart.addSeries(LineSeries, { visible: false }, 0);
    this.volume = this.chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: "volume" } },
      1,
    );
    this.chart.panes()[0]?.setStretchFactor(8);
    this.chart.panes()[1]?.setStretchFactor(2);

    this.resizeBatcher = createRafBatcher(({ width, height }) => {
      if (this.visible) {
        this.chartHeight = height;
        this.chart.applyOptions({ width, height });
        this.applyPaneRatios();
      }
    });
    this.crosshairBatcher = createRafBatcher((snapshot) => {
      this.callbacks.onCrosshairChange?.(
        snapshot.bar,
        snapshot.studyValues,
        snapshot.comparisonValues,
      );
    });
    this.chart.subscribeCrosshairMove(this.handleCrosshairMove);
    this.chart
      .timeScale()
      .subscribeVisibleLogicalRangeChange(this.handleVisibleRangeChange);
    this.host.addEventListener("pointerdown", this.handleHistoryInteraction);
    this.host.addEventListener("wheel", this.handleHistoryInteraction, {
      passive: true,
    });
    this.applyTheme(DEFAULT_PALETTE);
  }

  /** 更新由 React 外壳持有的事件回调。 */
  setCallbacks(callbacks: ChartCallbacks): void {
    const shouldSubscribeRange = Boolean(callbacks.onVisibleTimeRangeChange);
    const shouldSubscribeCrosshairPointer = Boolean(
      callbacks.onCrosshairTimeChange,
    );
    this.callbacks = callbacks;
    if (shouldSubscribeRange !== this.visibleTimeRangeSubscribed) {
      this.visibleTimeRangeSubscribed = shouldSubscribeRange;
      const timeScale = this.chart.timeScale();
      if (shouldSubscribeRange) {
        timeScale.subscribeVisibleTimeRangeChange(
          this.handleVisibleTimeRangeChange,
        );
      } else {
        timeScale.unsubscribeVisibleTimeRangeChange(
          this.handleVisibleTimeRangeChange,
        );
      }
    }
    if (shouldSubscribeCrosshairPointer !== this.crosshairPointerSubscribed) {
      this.crosshairPointerSubscribed = shouldSubscribeCrosshairPointer;
      if (shouldSubscribeCrosshairPointer) {
        this.host.addEventListener(
          "pointerenter",
          this.handleCrosshairPointerEnter,
        );
        this.host.addEventListener(
          "pointerleave",
          this.handleCrosshairPointerLeave,
        );
      } else {
        this.host.removeEventListener(
          "pointerenter",
          this.handleCrosshairPointerEnter,
        );
        this.host.removeEventListener(
          "pointerleave",
          this.handleCrosshairPointerLeave,
        );
        this.localCrosshairActive = false;
        this.pendingCrosshairSync = null;
      }
    }
  }

  /** 切换价格 series，不重建图表实例。 */
  setChartType(type: FinancialChartType): void {
    this.chartType = type;
    this.candles.applyOptions({ visible: type === "candlestick" });
    this.ohlc.applyOptions({ visible: type === "ohlc" });
    this.line.applyOptions({ visible: type === "line" });
    this.refreshPreviousCloseLine();
  }

  /** 应用价格精度、最小跳动和交易所时区格式，不改变 series 身份。 */
  setMarketMetadata(
    metadata: ChartMarketMetadata | null,
    locale: string,
  ): void {
    const precision = metadata?.pricePrecision ?? 2;
    const minMove = metadata?.minMove ?? 0.01;
    const timezone = metadata?.timezone ?? "UTC";
    const priceFormat = { type: "price" as const, precision, minMove };
    for (const series of [this.candles, this.ohlc, this.line]) {
      series.applyOptions({ priceFormat });
    }
    this.chart.applyOptions({
      localization: {
        locale,
        timeFormatter: (time: Time) =>
          typeof time === "number"
            ? formatMarketTimestamp(time, timezone, locale, "full")
            : typeof time === "string"
              ? time
              : `${time.year}-${String(time.month).padStart(2, "0")}-${String(
                  time.day,
                ).padStart(2, "0")}`,
      },
      timeScale: {
        tickMarkFormatter: (time: Time, type: TickMarkType) => {
          if (typeof time !== "number") return null;
          const style =
            type === TickMarkType.Year
              ? "year"
              : type === TickMarkType.Month
                ? "month"
                : type === TickMarkType.DayOfMonth
                  ? "day"
                  : type === TickMarkType.TimeWithSeconds
                    ? "time-seconds"
                    : "time";
          return formatMarketTimestamp(time, timezone, locale, style);
        },
      },
    });
  }

  /** 更新权威昨收与其本地化标题，并同步刷新最新价线方向。 */
  setPriceReference(
    reference: ChartPriceReference,
    previousCloseTitle: string,
  ): void {
    this.priceReference = reference;
    this.previousCloseTitle = previousCloseTitle;
    this.refreshPreviousCloseLine();
    this.refreshLatestPriceLine();
  }

  /** 应用语义 pane 比例，未知键保留给后续指标 pane 使用。 */
  setPaneRatios(ratios: PaneRatios): void {
    this.paneRatios = {
      ...ratios,
      main: this.validPaneRatio(ratios.main, DEFAULT_PANE_RATIOS.main),
      volume: this.validPaneRatio(ratios.volume, DEFAULT_PANE_RATIOS.volume),
    };
    this.applyPaneRatios();
  }

  /** 读取当前 pane 的最终比例，成交量隐藏时返回上次有效配置。 */
  getPaneRatios(): PaneRatios {
    if (this.chartHeight < MIN_CUSTOM_PANE_HEIGHT) {
      this.applyPaneRatios();
      return { ...this.paneRatios };
    }
    this.capturePaneRatios();
    return { ...this.paneRatios };
  }

  /** 隐藏成交量时移除空 pane，恢复时重新创建并应用用户比例。 */
  setShowVolume(showVolume: boolean): void {
    if (this.showVolume === showVolume) return;
    this.capturePaneRatios();
    this.showVolume = showVolume;
    const routed = routeChartStudies(
      this.studyResults,
      this.studyInstances,
      showVolume,
    );
    this.runChartMutation(() => {
      this.rebuildStudyPanes(routed);
    });
    this.studyPaneSignature = `${showVolume ? "volume" : "no-volume"}|${routed
      .filter((study) => study.result.pane === "separate")
      .map((study) => study.instance.instanceId)
      .join("|")}`;
  }

  /**
   * 增量同步服务端指标结果，复用未变化 series，并按 instance 顺序维护 pane。
   */
  setStudies(
    results: readonly ChartStudyResult[],
    instances: readonly ChartStudyInstance[],
  ): void {
    this.studyResults = results;
    this.studyInstances = instances;
    const routed = routeChartStudies(results, instances, this.showVolume);
    const signature = `${this.showVolume ? "volume" : "no-volume"}|${routed
      .filter((study) => study.result.pane === "separate")
      .map((study) => study.instance.instanceId)
      .join("|")}`;
    if (routed.length === 0 && this.studyRuntimes.size === 0) {
      this.studyPaneSignature = signature;
      this.crosshairStudyValues = {};
      return;
    }
    const desiredIds = new Set(
      routed.map((study) => study.instance.instanceId),
    );

    this.runChartMutation(() => {
      for (const [instanceId, runtime] of this.studyRuntimes) {
        if (!desiredIds.has(instanceId)) {
          this.removeStudyRuntime(runtime);
          this.studyRuntimes.delete(instanceId);
        }
      }

      for (const study of routed) {
        this.updateStudyRuntime(study);
      }

      if (signature !== this.studyPaneSignature) {
        this.capturePaneRatios();
        this.rebuildStudyPanes(routed);
        this.studyPaneSignature = signature;
      } else {
        for (const study of routed) {
          const runtime = this.studyRuntimes.get(study.instance.instanceId);
          if (runtime) runtime.paneIndex = study.paneIndex;
        }
        this.applyPaneRatios();
      }
    });
    this.crosshairStudyValues = {};
  }

  /**
   * 按证券身份增量维护相对收益线，并让全部线共用独立左侧百分比轴。
   */
  setComparisons(
    mainVtSymbol: string | null,
    series: readonly ChartComparisonSeries[],
  ): void {
    if (series.length === 0 && this.comparisonRuntimes.size === 0) {
      this.mainComparisonVtSymbol = null;
      this.comparisonSeries = series;
      this.crosshairComparisonValues = {};
      return;
    }
    this.mainComparisonVtSymbol = mainVtSymbol;
    this.comparisonSeries = series;
    const desiredSymbols = new Set(series.map((item) => item.vtSymbol));

    this.runChartMutation(() => {
      for (const [vtSymbol, runtime] of this.comparisonRuntimes) {
        if (desiredSymbols.has(vtSymbol)) continue;
        this.comparisonSeriesMetadata.delete(runtime.series);
        this.chart.removeSeries(runtime.series);
        this.comparisonRuntimes.delete(vtSymbol);
      }

      for (const item of series) {
        let runtime = this.comparisonRuntimes.get(item.vtSymbol);
        if (!runtime) {
          const line = this.chart.addSeries(
            LineSeries,
            {
              priceScaleId: "left",
              lineWidth: 2,
              priceLineVisible: false,
              lastValueVisible: false,
              crosshairMarkerVisible: false,
              priceFormat: {
                type: "custom",
                minMove: 0.01,
                formatter: (value: number) => `${value.toFixed(2)}%`,
              },
            },
            0,
          );
          runtime = { item, series: line };
          this.comparisonRuntimes.set(item.vtSymbol, runtime);
          this.comparisonSeriesMetadata.set(line, item.vtSymbol);
        }
        runtime.item = item;
        runtime.series.applyOptions({
          color:
            item.vtSymbol === mainVtSymbol ? this.palette.line : item.color,
        });
        runtime.series.setData(
          item.points.map((point) => ({
            time: financialChartTime(point.time),
            value: point.value,
          })),
        );
      }

      this.chart.applyOptions({
        leftPriceScale: {
          visible: series.length > 0,
          borderVisible: series.length > 0,
          borderColor: this.palette.border,
        },
      });
    });

    const crosshairBar =
      this.crosshairTimeKey === null
        ? null
        : (this.barsByTime.get(this.crosshairTimeKey) ?? null);
    this.crosshairComparisonValues = crosshairBar
      ? this.comparisonValuesAtTime(crosshairBar.time)
      : {};
    if (this.crosshairTimeKey !== null) {
      this.crosshairBatcher.schedule({
        bar: crosshairBar,
        studyValues: this.crosshairStudyValues,
        comparisonValues: this.crosshairComparisonValues,
      });
    }
  }

  /** 应用 Terax 主题色，不改变用户 viewport。 */
  applyTheme(palette: FinancialChartPalette): void {
    this.palette = palette;
    this.runChartMutation(() => {
      this.chart.applyOptions({
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: palette.text,
        },
        grid: {
          vertLines: { color: palette.grid },
          horzLines: { color: palette.grid },
        },
        crosshair: {
          vertLine: {
            color: palette.crosshair,
            labelBackgroundColor: palette.border,
          },
          horzLine: {
            color: palette.crosshair,
            labelBackgroundColor: palette.border,
          },
        },
        leftPriceScale: {
          visible: this.comparisonRuntimes.size > 0,
          borderVisible: this.comparisonRuntimes.size > 0,
          borderColor: palette.border,
        },
        rightPriceScale: { borderColor: palette.border },
        timeScale: { borderColor: palette.border },
      });
      this.candles.applyOptions({
        upColor: palette.up,
        downColor: palette.down,
        borderUpColor: palette.up,
        borderDownColor: palette.down,
        wickUpColor: palette.up,
        wickDownColor: palette.down,
      });
      this.ohlc.applyOptions({ upColor: palette.up, downColor: palette.down });
      this.line.applyOptions({ color: palette.line, lineWidth: 2 });
      for (const [vtSymbol, runtime] of this.comparisonRuntimes) {
        runtime.series.applyOptions({
          color:
            vtSymbol === this.mainComparisonVtSymbol
              ? palette.line
              : runtime.item.color,
        });
      }
      if (this.bars.length > 0) {
        this.volume.setData(
          buildFinancialSeriesData(this.bars, palette).volume,
        );
      }
      this.refreshPreviousCloseLine();
      this.refreshLatestPriceLine();
    });
    if (this.studyRuntimes.size > 0) {
      this.setStudies(this.studyResults, this.studyInstances);
    }
  }

  /**
   * 更新行情快照。
   *
   * 相同数据键允许尾部 `update()`；历史 prepend 使用原逻辑范围加偏移恢复画面。
   */
  setBars(dataKey: string, bars: readonly MarketBar[]): void {
    const keyChanged = dataKey !== this.dataKey;
    if (keyChanged) this.liveTail = [];
    this.stableBars = bars;
    const merged = mergeMarketBarTail(bars, this.liveTail);
    this.applyBars(dataKey, merged, keyChanged);
  }

  /** 停用实时订阅时移除内存尾部并恢复最近 HTTP 稳定快照。 */
  clearRealtime(dataKey: string): void {
    if (dataKey !== this.dataKey || this.liveTail.length === 0) return;
    this.liveTail = [];
    this.applyBars(dataKey, this.stableBars, false);
  }

  /**
   * 直接更新当前实时尾部。
   *
   * 同 bucket 不复制历史数组，新 bucket 只追加一次；旧数据键和迟到 bar 被拒绝。
   */
  updateLiveBar(dataKey: string, incoming: MarketBar): boolean {
    if (dataKey !== this.dataKey) return false;
    const lastKnown = this.bars[this.bars.length - 1] ?? null;
    const previous =
      this.liveTail[this.liveTail.length - 1] ??
      (lastKnown
        ? (this.barsByTime.get(
            chartTimeKey(financialChartTime(lastKnown.time)),
          ) ?? lastKnown)
        : null);
    const previousTime = previous ? marketTimeKey(previous.time) : -Infinity;
    const incomingTime = marketTimeKey(incoming.time);
    if (incomingTime < previousTime) return false;
    const mode = incomingTime === previousTime ? "replace" : "append";
    const bar = incoming;
    const timeKey = chartTimeKey(financialChartTime(bar.time));
    const data = buildFinancialSeriesData(
      [bar],
      this.palette,
      this.previousCloseForLiveBar(bar),
    );
    if (mode === "replace") {
      if (
        this.liveTail.length > 0 &&
        marketTimeKey(this.liveTail[this.liveTail.length - 1].time) ===
          marketTimeKey(bar.time)
      ) {
        this.liveTail[this.liveTail.length - 1] = bar;
      } else {
        this.liveTail = [bar];
      }
    } else {
      this.liveTail.push(bar);
      if (this.liveTail.length > 512) this.liveTail.shift();
      this.bars = [...this.bars, bar];
    }
    this.barsByTime.set(timeKey, bar);
    this.runChartMutation(() => {
      this.candles.update(data.candles[0]);
      this.ohlc.update(data.ohlc[0]);
      this.line.update(data.line[0]);
      this.volume.update(data.volume[0]);
      if (mode === "append" && this.followingLatest) {
        this.chart.timeScale().scrollToRealTime();
      }
    });
    this.refreshLatestPriceLine();
    this.callbacks.onLatestBarChange?.(bar);
    return true;
  }

  /** 返回用户当前是否允许新 bar 保持在实时尾部。 */
  isFollowingLatest(): boolean {
    return this.followingLatest;
  }

  /** 主动滚回实时尾部并恢复自动跟随，不执行 fitContent。 */
  returnToLatest(): void {
    if (this.bars.length === 0 && this.liveTail.length === 0) return;
    this.historyInteractionArmed = false;
    this.setFollowingLatest(true);
    this.runChartMutation(() => this.chart.timeScale().scrollToRealTime());
  }

  private applyBars(
    dataKey: string,
    bars: readonly MarketBar[],
    keyChanged: boolean,
  ): void {
    const previous = keyChanged ? [] : this.bars;
    const tailMode = financialTailUpdateMode(previous, bars);

    if (!keyChanged && tailMode === "unchanged") return;

    if (!keyChanged && (tailMode === "replace" || tailMode === "append")) {
      const last = bars[bars.length - 1];
      const previousClose =
        bars.length > 1 ? (bars[bars.length - 2]?.close ?? null) : null;
      const data = buildFinancialSeriesData(
        [last],
        this.palette,
        previousClose,
      );
      this.dataKey = dataKey;
      this.bars = bars;
      this.barsByTime.set(chartTimeKey(financialChartTime(last.time)), last);
      this.runChartMutation(() => {
        this.candles.update(data.candles[0]);
        this.ohlc.update(data.ohlc[0]);
        this.line.update(data.line[0]);
        this.volume.update(data.volume[0]);
      });
    } else {
      const timeScale = this.chart.timeScale();
      const visibleRange = keyChanged
        ? null
        : timeScale.getVisibleLogicalRange();
      const prepended = countPrependedBars(previous, bars);
      const data = buildFinancialSeriesData(bars, this.palette);
      this.dataKey = dataKey;
      this.bars = bars;
      this.barsByTime = new Map(
        bars.map((bar) => [chartTimeKey(financialChartTime(bar.time)), bar]),
      );
      if (keyChanged) {
        this.requestPending = false;
        this.historyInteractionArmed = false;
        this.setFollowingLatest(true);
      }
      this.runChartMutation(() => {
        this.candles.setData(data.candles);
        this.ohlc.setData(data.ohlc);
        this.line.setData(data.line);
        this.volume.setData(data.volume);

        if (visibleRange && prepended > 0) {
          timeScale.setVisibleLogicalRange({
            from: (visibleRange.from + prepended) as Logical,
            to: (visibleRange.to + prepended) as Logical,
          });
        } else if (bars.length > 0 && (keyChanged || previous.length === 0)) {
          this.candles.priceScale().applyOptions({ autoScale: true });
          timeScale.fitContent();
        }
      });
    }

    const latest = bars[bars.length - 1];
    if (latest) this.callbacks.onLatestBarChange?.(latest);

    this.refreshLatestPriceLine();

    if (this.crosshairTimeKey !== null) {
      this.crosshairBatcher.schedule({
        bar: this.barsByTime.get(this.crosshairTimeKey) ?? null,
        studyValues: this.crosshairStudyValues,
        comparisonValues: this.crosshairComparisonValues,
      });
    }
  }

  /** 更新历史分页状态，避免同一左边界并发发起多个请求。 */
  setHistoryState(hasMoreBefore: boolean, loadingMore: boolean): void {
    if (this.loadingMore && !loadingMore) this.requestPending = false;
    this.hasMoreBefore = hasMoreBefore;
    this.loadingMore = loadingMore;
  }

  /** 应用来自同组兼容图表的实际时间范围，并在当前帧内阻止回传。 */
  setVisibleTimeRangeFromSync(range: ChartTimeRange): void {
    if (!this.visible || this.bars.length === 0) return;
    this.syncRangeMutationInProgress = true;
    this.runChartMutation(() => {
      this.chart.timeScale().setVisibleRange({
        from: financialChartTime(range.from),
        to: financialChartTime(range.to),
      });
    });
    // Lightweight Charts 可能在命令返回后才派发范围变化，保护保持到下一帧。
    this.syncRangeReleaseBatcher ??= createRafBatcher(() => {
      this.syncRangeMutationInProgress = false;
    });
    this.syncRangeReleaseBatcher.schedule(null);
  }

  /**
   * 应用远端十字线时间。
   *
   * `localBar` 必须来自接收图表的精确时间匹配；本地 pointer 活跃时只暂存远端位置。
   */
  setCrosshairFromSync(
    time: MarketTime | null,
    localBar: MarketBar | null,
  ): void {
    if (this.localCrosshairActive) {
      this.pendingCrosshairSync = { time, localBar };
      return;
    }
    this.applyCrosshairFromSync(time, localBar);
  }

  /** 页面隐藏时暂停尺寸和历史加载响应，但保留 Canvas 与 viewport。 */
  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  /** 合并同一帧内的尺寸变化。 */
  resize(width: number, height: number): void {
    if (!this.visible || width <= 0 || height <= 0) return;
    this.resizeBatcher.schedule({ width, height });
  }

  /** 截取当前图表且排除十字线，不改变 viewport 或 pane 比例。 */
  takeScreenshot(): HTMLCanvasElement {
    return this.chart.takeScreenshot(false, false);
  }

  /** 恢复价格自动缩放并让时间轴重新适配全部已加载数据。 */
  resetView(): void {
    if (this.bars.length === 0) return;
    this.historyInteractionArmed = false;
    this.setFollowingLatest(true);
    this.runChartMutation(() => {
      this.candles.priceScale().applyOptions({ autoScale: true });
      this.chart.timeScale().fitContent();
    });
  }

  /** 释放图表实例和全部监听器。 */
  destroy(): void {
    this.resizeBatcher.cancel();
    this.crosshairBatcher.cancel();
    this.syncRangeReleaseBatcher?.cancel();
    this.chart.unsubscribeCrosshairMove(this.handleCrosshairMove);
    if (this.visibleTimeRangeSubscribed) {
      this.chart
        .timeScale()
        .unsubscribeVisibleTimeRangeChange(this.handleVisibleTimeRangeChange);
    }
    if (this.crosshairPointerSubscribed) {
      this.host.removeEventListener(
        "pointerenter",
        this.handleCrosshairPointerEnter,
      );
      this.host.removeEventListener(
        "pointerleave",
        this.handleCrosshairPointerLeave,
      );
    }
    this.chart
      .timeScale()
      .unsubscribeVisibleLogicalRangeChange(this.handleVisibleRangeChange);
    this.host.removeEventListener("pointerdown", this.handleHistoryInteraction);
    this.host.removeEventListener("wheel", this.handleHistoryInteraction);
    this.chart.remove();
  }

  private readonly handleCrosshairMove = (
    params: MouseEventParams<Time>,
  ): void => {
    this.crosshairTimeKey =
      params.time === undefined ? null : chartTimeKey(params.time);
    const bar =
      this.crosshairTimeKey === null
        ? null
        : (this.barsByTime.get(this.crosshairTimeKey) ?? null);
    const studyValues: ChartStudyLegendValues = {};
    for (const [series, metadata] of this.studySeriesMetadata) {
      const data = params.seriesData.get(series);
      const value =
        data && "value" in data && Number.isFinite(data.value)
          ? data.value
          : null;
      studyValues[metadata.instanceId] ??= {};
      studyValues[metadata.instanceId][metadata.outputId] = value;
    }
    this.crosshairStudyValues = studyValues;
    const comparisonValues: ChartComparisonLegendValues = {};
    for (const [series, vtSymbol] of this.comparisonSeriesMetadata) {
      const data = params.seriesData.get(series);
      comparisonValues[vtSymbol] =
        data && "value" in data && Number.isFinite(data.value)
          ? data.value
          : null;
    }
    this.crosshairComparisonValues = comparisonValues;
    this.crosshairBatcher.schedule({
      bar,
      studyValues,
      comparisonValues,
    });
    if (
      this.localCrosshairActive &&
      !this.chartMutationInProgress &&
      !this.syncCrosshairMutationInProgress
    ) {
      this.callbacks.onCrosshairTimeChange?.(bar?.time ?? null);
    }
  };

  /** 标记本地 pointer 正在控制十字线，远端位置在此期间只暂存。 */
  private readonly handleCrosshairPointerEnter = (): void => {
    this.localCrosshairActive = true;
  };

  /** 本地 pointer 离开后发布清除事件，并恢复期间收到的最后远端位置。 */
  private readonly handleCrosshairPointerLeave = (): void => {
    if (!this.localCrosshairActive) return;
    this.localCrosshairActive = false;
    this.callbacks.onCrosshairTimeChange?.(null);
    const pending = this.pendingCrosshairSync;
    this.pendingCrosshairSync = null;
    if (pending) this.applyCrosshairFromSync(pending.time, pending.localBar);
  };

  /** 只发布用户产生且能还原为公共行情时间的实际可见范围。 */
  private readonly handleVisibleTimeRangeChange = (
    range: IRange<Time> | null,
  ): void => {
    if (
      !this.visible ||
      !this.historyInteractionArmed ||
      this.chartMutationInProgress ||
      this.syncRangeMutationInProgress ||
      !range ||
      !this.callbacks.onVisibleTimeRangeChange
    ) {
      return;
    }
    const from = marketTimeFromChartTime(range.from);
    const to = marketTimeFromChartTime(range.to);
    if (from && to) this.callbacks.onVisibleTimeRangeChange({ from, to });
  };

  /** 响应用户触发的左边界变化，并保证同一历史边界只请求一次。 */
  private readonly handleVisibleRangeChange = (
    range: LogicalRange | null,
  ): void => {
    if (
      this.visible &&
      this.historyInteractionArmed &&
      !this.chartMutationInProgress &&
      !this.syncRangeMutationInProgress &&
      range
    ) {
      this.keepBarsVisibleAfterPan(range);
      this.setFollowingLatest(range.to >= this.bars.length - 1.5);
    }
    if (
      !this.visible ||
      !this.historyInteractionArmed ||
      this.chartMutationInProgress ||
      this.syncRangeMutationInProgress ||
      !range ||
      range.from >= HISTORY_LOAD_THRESHOLD ||
      !this.hasMoreBefore ||
      this.loadingMore ||
      this.requestPending ||
      !this.callbacks.onRequestMore
    ) {
      return;
    }
    this.requestPending = true;
    this.callbacks.onRequestMore();
  };

  /** 平移越过数据两端时保留少量 K 线，避免图表看起来完全空白。 */
  private keepBarsVisibleAfterPan(range: LogicalRange): void {
    const width = range.to - range.from;
    if (this.bars.length === 0 || width <= 0) return;

    const requiredBars = Math.min(
      MIN_VISIBLE_BARS_AFTER_PAN,
      this.bars.length,
      Math.max(1, Math.floor(width)),
    );
    const lastIndex = this.bars.length - 1;
    let from: number = range.from;
    let to: number = range.to;

    if (to < requiredBars - 1) {
      to = requiredBars - 1;
      from = to - width;
    } else if (from > lastIndex - requiredBars + 1) {
      from = lastIndex - requiredBars + 1;
      to = from + width;
    } else {
      return;
    }

    this.runChartMutation(() => {
      this.chart.timeScale().setVisibleLogicalRange({
        from: from as Logical,
        to: to as Logical,
      });
    });
  }

  /** 标记用户已操作时间轴，避免初始化和尺寸事件自动预取历史。 */
  private readonly handleHistoryInteraction = (): void => {
    this.historyInteractionArmed = true;
  };

  /** 只在状态实际变化时通知 React 外壳。 */
  private setFollowingLatest(following: boolean): void {
    if (this.followingLatest === following) return;
    this.followingLatest = following;
    this.callbacks.onFollowingLatestChange?.(following);
  }

  /** 返回实时 bar 着色所需的精确前一收盘。 */
  private previousCloseForLiveBar(bar: MarketBar): number | null {
    const target = marketTimeKey(bar.time);
    let previous: MarketBar | null = null;
    for (const candidate of this.barsByTime.values()) {
      const key = marketTimeKey(candidate.time);
      if (key < target && (!previous || key > marketTimeKey(previous.time))) {
        previous = candidate;
      }
    }
    return previous?.close ?? null;
  }

  /** 返回当前可见的主价格 series。 */
  private activePriceSeries(): ISeriesApi<"Candlestick" | "Bar" | "Line"> {
    if (this.chartType === "ohlc") return this.ohlc;
    if (this.chartType === "line") return this.line;
    return this.candles;
  }

  /** 执行十字线同步命令，缺少精确本地 bar 时显式清除位置。 */
  private applyCrosshairFromSync(
    time: MarketTime | null,
    localBar: MarketBar | null,
  ): void {
    this.syncCrosshairMutationInProgress = true;
    try {
      if (time && localBar) {
        this.chart.setCrosshairPosition(
          localBar.close,
          financialChartTime(localBar.time),
          this.activePriceSeries(),
        );
      } else {
        this.chart.clearCrosshairPosition();
      }
    } finally {
      this.syncCrosshairMutationInProgress = false;
    }
    this.crosshairTimeKey =
      time && localBar ? chartTimeKey(financialChartTime(localBar.time)) : null;
    this.crosshairStudyValues =
      time && localBar ? this.studyValuesAtTime(localBar.time) : {};
    this.crosshairComparisonValues =
      time && localBar ? this.comparisonValuesAtTime(localBar.time) : {};
    this.crosshairBatcher.schedule({
      bar: time && localBar ? localBar : null,
      studyValues: this.crosshairStudyValues,
      comparisonValues: this.crosshairComparisonValues,
    });
  }

  /** 用二分查找提取同步时间的指标值，不增加 series 订阅或常驻时间索引。 */
  private studyValuesAtTime(time: MarketTime): ChartStudyLegendValues {
    const target = marketTimeKey(time);
    const values: ChartStudyLegendValues = {};
    for (const result of this.studyResults) {
      const outputs: Record<string, number | null> = {};
      for (const output of result.outputs) {
        let low = 0;
        let high = output.points.length - 1;
        let value: number | null = null;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const point = output.points[middle];
          const key = marketTimeKey(point.time);
          if (key === target) {
            value = point.value;
            break;
          }
          if (key < target) low = middle + 1;
          else high = middle - 1;
        }
        outputs[output.id] = value;
      }
      values[result.instanceId] = outputs;
    }
    return values;
  }

  /** 精确提取同步时间的相对收益值，不把停牌前旧点延伸到当前时间。 */
  private comparisonValuesAtTime(
    time: MarketTime,
  ): ChartComparisonLegendValues {
    const target = marketTimeKey(time);
    const values: ChartComparisonLegendValues = {};
    for (const item of this.comparisonSeries) {
      let low = 0;
      let high = item.points.length - 1;
      let value: number | null = null;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const point = item.points[middle];
        const key = marketTimeKey(point.time);
        if (key === target) {
          value = point.value;
          break;
        }
        if (key < target) low = middle + 1;
        else high = middle - 1;
      }
      values[item.vtSymbol] = value;
    }
    return values;
  }

  /** 只在权威参考价存在时为当前可见价格 series 创建昨收线。 */
  private refreshPreviousCloseLine(): void {
    if (this.previousCloseLine && this.previousCloseSeries) {
      this.previousCloseSeries.removePriceLine(this.previousCloseLine);
    }
    this.previousCloseLine = null;
    this.previousCloseSeries = null;
    const previousClose = this.priceReference.previousClose;
    if (previousClose === null || !Number.isFinite(previousClose)) return;
    const series = this.activePriceSeries();
    this.previousCloseLine = series.createPriceLine({
      price: previousClose,
      color: this.palette.crosshair,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: this.previousCloseTitle,
    });
    this.previousCloseSeries = series;
  }

  /** 显式配置最新价线，并按最新收盘价相对权威昨收选择方向色。 */
  private refreshLatestPriceLine(): void {
    const latest =
      this.liveTail[this.liveTail.length - 1] ??
      this.bars[this.bars.length - 1];
    const previousClose = this.priceReference.previousClose;
    const color = latest
      ? latest.close >= (previousClose ?? latest.open)
        ? this.palette.up
        : this.palette.down
      : this.palette.line;
    for (const series of [this.candles, this.ohlc, this.line]) {
      series.applyOptions({
        priceLineVisible: true,
        lastValueVisible: true,
        priceLineColor: color,
        priceLineWidth: 1,
        priceLineStyle: LineStyle.Dotted,
      });
    }
  }

  /** 把非正数和非有限比例降级为当前版本默认值。 */
  private validPaneRatio(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  }

  /** 将语义比例应用到当前存在的价格和成交量 pane。 */
  private applyPaneRatios(): void {
    const panes = this.chart.panes();
    const ratios =
      this.chartHeight < MIN_CUSTOM_PANE_HEIGHT
        ? DEFAULT_PANE_RATIOS
        : this.paneRatios;
    panes[0]?.setStretchFactor(ratios.main);
    if (this.showVolume) {
      panes[1]?.setStretchFactor(ratios.volume);
    }
    for (const runtime of this.studyRuntimes.values()) {
      if (runtime.pane !== "separate" || runtime.paneIndex <= 0) continue;
      panes[runtime.paneIndex]?.setStretchFactor(
        this.validPaneRatio(ratios[runtime.instanceId], 2),
      );
    }
  }

  /** 在 pane 结构变化前读取当前语义比例，避免依赖易变化的数字索引。 */
  private capturePaneRatios(): void {
    if (this.chartHeight < MIN_CUSTOM_PANE_HEIGHT) return;
    const panes = this.chart.panes();
    const main = panes[0]?.getStretchFactor();
    const volume = this.showVolume ? panes[1]?.getStretchFactor() : null;
    if (main && Number.isFinite(main)) this.paneRatios.main = main;
    if (volume && Number.isFinite(volume)) this.paneRatios.volume = volume;
    for (const runtime of this.studyRuntimes.values()) {
      if (runtime.pane !== "separate" || runtime.paneIndex <= 0) continue;
      const ratio = panes[runtime.paneIndex]?.getStretchFactor();
      if (ratio && Number.isFinite(ratio)) {
        this.paneRatios[runtime.instanceId] = ratio;
      }
    }
  }

  /** 创建一种指标 series，初始放入主 pane，结构稳定后再统一路由。 */
  private createStudySeries(kind: ChartStudySeriesKind): StudySeriesApi {
    if (kind === "histogram") {
      return this.chart.addSeries(
        HistogramSeries,
        { priceLineVisible: false, lastValueVisible: false },
        0,
      );
    }
    return this.chart.addSeries(
      LineSeries,
      {
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      },
      0,
    );
  }

  /** 对单个 instance 做 output 级 diff，并更新数据、样式与参考水平线。 */
  private updateStudyRuntime(study: RoutedChartStudy): void {
    const { instance, result } = study;
    let runtime = this.studyRuntimes.get(instance.instanceId);
    if (!runtime) {
      runtime = {
        instanceId: instance.instanceId,
        pane: result.pane,
        paneIndex: 0,
        outputs: new Map(),
        levelLines: [],
      };
      this.studyRuntimes.set(instance.instanceId, runtime);
    }
    runtime.pane = result.pane;
    const incoming = new Map(
      result.outputs.map((output) => [output.id, output]),
    );

    for (const [outputId, outputRuntime] of runtime.outputs) {
      const next = incoming.get(outputId);
      if (!next || next.kind !== outputRuntime.kind) {
        this.studySeriesMetadata.delete(outputRuntime.series);
        this.chart.removeSeries(outputRuntime.series);
        runtime.outputs.delete(outputId);
      }
    }

    for (const output of result.outputs) {
      const style = instance.styles[output.id] ?? {
        color: this.palette.line,
        lineWidth: 2 as const,
      };
      let outputRuntime = runtime.outputs.get(output.id);
      if (!outputRuntime) {
        outputRuntime = {
          kind: output.kind,
          series: this.createStudySeries(output.kind),
        };
        runtime.outputs.set(output.id, outputRuntime);
      }
      const series = outputRuntime.series;
      series.applyOptions(
        output.kind === "line"
          ? { color: style.color, lineWidth: style.lineWidth }
          : { color: style.color },
      );
      series.setData(
        buildChartStudySeriesData(output, style, this.palette) as never,
      );
      this.studySeriesMetadata.set(series, {
        instanceId: instance.instanceId,
        outputId: output.id,
      });
    }

    for (const level of runtime.levelLines) {
      level.series.removePriceLine(level.line);
    }
    runtime.levelLines = [];
    const firstSeries = runtime.outputs.values().next().value?.series;
    if (firstSeries && result.pane === "separate") {
      runtime.levelLines = result.levels.map((price) => ({
        series: firstSeries,
        line: firstSeries.createPriceLine({
          price,
          color: this.palette.grid,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: false,
          title: "",
        }),
      }));
    }
  }

  /** 移除一个实例的全部 series 和价格线，主价格 series 不受影响。 */
  private removeStudyRuntime(runtime: StudyRuntime): void {
    for (const level of runtime.levelLines) {
      level.series.removePriceLine(level.line);
    }
    for (const output of runtime.outputs.values()) {
      this.studySeriesMetadata.delete(output.series);
      this.chart.removeSeries(output.series);
    }
  }

  /**
   * 复用 series 重建辅助 pane 顺序，并在同步 mutation 内恢复语义比例。
   */
  private rebuildStudyPanes(routed: readonly RoutedChartStudy[]): void {
    for (const runtime of this.studyRuntimes.values()) {
      if (runtime.pane !== "separate") continue;
      for (const output of runtime.outputs.values())
        output.series.moveToPane(0);
      runtime.paneIndex = 0;
    }
    this.volume.moveToPane(0);
    for (let index = this.chart.panes().length - 1; index >= 1; index -= 1) {
      this.chart.removePane(index);
    }
    if (this.showVolume) {
      this.volume.moveToPane(1);
      this.volume.applyOptions({ visible: true });
    } else {
      this.volume.applyOptions({ visible: false });
    }
    for (const study of routed) {
      const runtime = this.studyRuntimes.get(study.instance.instanceId);
      if (!runtime) continue;
      runtime.paneIndex = study.paneIndex;
      if (study.result.pane === "separate") {
        for (const output of runtime.outputs.values()) {
          output.series.moveToPane(study.paneIndex);
        }
      }
    }
    this.applyPaneRatios();
  }

  /** 执行可能同步改变可见范围的图表命令，避免内部事件误触发历史请求。 */
  private runChartMutation(action: () => void): void {
    this.chartMutationInProgress = true;
    try {
      action();
    } finally {
      this.chartMutationInProgress = false;
    }
  }
}
