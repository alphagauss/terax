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
  FinancialChartPalette,
  FinancialChartType,
} from "@/modules/alpha/chart/model";
import { createRafBatcher } from "@/modules/alpha/chart/rafBatcher";
import type { MarketBar } from "@/modules/alpha/market/model";
import {
  BarSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  type Logical,
  type LogicalRange,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";

const HISTORY_LOAD_THRESHOLD = 20;
const MIN_VISIBLE_BARS_AFTER_PAN = 8;

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
      if (this.visible) this.chart.applyOptions({ width, height });
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
    this.candles.applyOptions({ visible: type === "candlestick" });
    this.ohlc.applyOptions({ visible: type === "ohlc" });
    this.line.applyOptions({ visible: type === "line" });
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
      const data = buildFinancialSeriesData([last], this.palette);
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
