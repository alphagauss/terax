/**
 * 本文件封装 Alpha 公共金融图表的 Lightweight Charts 运行时。
 * Controller 独占实例、series、监听器和 viewport 命令，不执行查询或持久化。
 */

import {
  buildFinancialSeriesData,
  countPrependedBars,
  financialChartTime,
  financialTailUpdateMode,
} from "@/modules/alpha/chart/lightweight/data";
import type {
  ChartMarketMetadata,
  ChartPriceReference,
  FinancialChartPalette,
  FinancialChartType,
  PaneRatios,
} from "@/modules/alpha/chart/model";
import { createRafBatcher } from "@/modules/alpha/chart/rafBatcher";
import type { MarketBar } from "@/modules/alpha/market/model";
import { formatMarketTimestamp } from "@/modules/alpha/market/metadata";
import {
  BarSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineStyle,
  LineSeries,
  type Logical,
  type LogicalRange,
  type MouseEventParams,
  type Time,
  TickMarkType,
} from "lightweight-charts";

const HISTORY_LOAD_THRESHOLD = 20;
const MIN_VISIBLE_BARS_AFTER_PAN = 8;
const DEFAULT_PANE_RATIOS: PaneRatios = { main: 8, volume: 2 };
const MIN_CUSTOM_PANE_HEIGHT = 240;

type ChartCallbacks = {
  onCrosshairChange?: (bar: MarketBar | null) => void;
  onRequestMore?: () => void;
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
    typeof createRafBatcher<MarketBar | null>
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
  private barsByTime = new Map<string, MarketBar>();
  private dataKey = "";
  private visible = true;
  private hasMoreBefore = false;
  private loadingMore = false;
  private requestPending = false;
  private chartMutationInProgress = false;
  private crosshairTimeKey: string | null = null;
  private historyInteractionArmed = false;

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
    this.crosshairBatcher = createRafBatcher((bar) => {
      this.callbacks.onCrosshairChange?.(bar);
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
    this.callbacks = callbacks;
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
    if (this.showVolume) {
      const panes = this.chart.panes();
      const main = panes[0]?.getStretchFactor();
      const volume = panes[1]?.getStretchFactor();
      if (main && volume) {
        this.paneRatios = { ...this.paneRatios, main, volume };
      }
    }
    return { ...this.paneRatios };
  }

  /** 隐藏成交量时移除空 pane，恢复时重新创建并应用用户比例。 */
  setShowVolume(showVolume: boolean): void {
    this.showVolume = showVolume;
    this.runChartMutation(() => {
      if (showVolume) {
        this.volume.moveToPane(1);
        this.volume.applyOptions({ visible: true });
        this.applyPaneRatios();
      } else {
        this.volume.applyOptions({ visible: false });
        this.volume.moveToPane(0);
      }
    });
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
      if (this.bars.length > 0) {
        this.volume.setData(
          buildFinancialSeriesData(this.bars, palette).volume,
        );
      }
      this.refreshPreviousCloseLine();
      this.refreshLatestPriceLine();
    });
  }

  /**
   * 更新行情快照。
   *
   * 相同数据键允许尾部 `update()`；历史 prepend 使用原逻辑范围加偏移恢复画面。
   */
  setBars(dataKey: string, bars: readonly MarketBar[]): void {
    const keyChanged = dataKey !== this.dataKey;
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

    this.refreshLatestPriceLine();

    if (this.crosshairTimeKey !== null) {
      this.crosshairBatcher.schedule(
        this.barsByTime.get(this.crosshairTimeKey) ?? null,
      );
    }
  }

  /** 更新历史分页状态，避免同一左边界并发发起多个请求。 */
  setHistoryState(hasMoreBefore: boolean, loadingMore: boolean): void {
    if (this.loadingMore && !loadingMore) this.requestPending = false;
    this.hasMoreBefore = hasMoreBefore;
    this.loadingMore = loadingMore;
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

  /** 恢复价格自动缩放并让时间轴重新适配全部已加载数据。 */
  resetView(): void {
    if (this.bars.length === 0) return;
    this.historyInteractionArmed = false;
    this.runChartMutation(() => {
      this.candles.priceScale().applyOptions({ autoScale: true });
      this.chart.timeScale().fitContent();
    });
  }

  /** 释放图表实例和全部监听器。 */
  destroy(): void {
    this.resizeBatcher.cancel();
    this.crosshairBatcher.cancel();
    this.chart.unsubscribeCrosshairMove(this.handleCrosshairMove);
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
    this.crosshairBatcher.schedule(bar);
  };

  /** 响应用户触发的左边界变化，并保证同一历史边界只请求一次。 */
  private readonly handleVisibleRangeChange = (
    range: LogicalRange | null,
  ): void => {
    if (
      this.visible &&
      this.historyInteractionArmed &&
      !this.chartMutationInProgress &&
      range
    ) {
      this.keepBarsVisibleAfterPan(range);
    }
    if (
      !this.visible ||
      !this.historyInteractionArmed ||
      this.chartMutationInProgress ||
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

  /** 返回当前可见的主价格 series。 */
  private activePriceSeries(): ISeriesApi<"Candlestick" | "Bar" | "Line"> {
    if (this.chartType === "ohlc") return this.ohlc;
    if (this.chartType === "line") return this.line;
    return this.candles;
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
    const latest = this.bars[this.bars.length - 1];
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
