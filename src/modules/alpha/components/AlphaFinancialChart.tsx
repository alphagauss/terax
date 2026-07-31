/**
 * 本文件使用 Lightweight Charts 渲染 Alpha 日 K 线和成交量。
 * 图表只消费后端返回的数据，不在 WebView 中计算量化指标。
 */

import type { AlphaBar } from "@/modules/alpha/api";
import { useTheme } from "@/modules/theme";
import {
  type BusinessDay,
  CandlestickSeries,
  type IChartApi,
  type ISeriesApi,
  HistogramSeries,
  createChart,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

type Props = {
  bars: AlphaBar[];
  visible: boolean;
  ariaLabel: string;
};

/** 把后端日线日期转换为不受本地时区影响的交易日。 */
export function alphaBusinessDay(value: string): BusinessDay {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return { year, month, day };
}

function cssColor(container: HTMLElement, name: string): string {
  return getComputedStyle(container).getPropertyValue(name).trim();
}

/**
 * 渲染单证券日 K 线和独立成交量窗格。
 *
 * 页面隐藏时保留 Canvas，恢复可见后重新适配时间轴。
 */
export function AlphaFinancialChart({ bars, visible, ariaLabel }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const { resolvedMode, themeId } = useTheme();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        attributionLogo: true,
      },
      timeScale: {
        borderVisible: false,
      },
      rightPriceScale: {
        borderVisible: false,
      },
    });
    const candles = chart.addSeries(CandlestickSeries);
    const volume = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceScaleId: "",
      },
      1,
    );
    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  // 主题色来自 CSS 变量，这两个值仅用于在主题切换完成后触发重新读取。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 不能从 getComputedStyle 推导主题依赖。
  useEffect(() => {
    const container = containerRef.current;
    const chart = chartRef.current;
    if (!container || !chart) return;
    chart.applyOptions({
      layout: {
        background: { color: "transparent" },
        textColor: cssColor(container, "--muted-foreground"),
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: cssColor(container, "--border") },
        horzLines: { color: cssColor(container, "--border") },
      },
    });
  }, [resolvedMode, themeId]);

  useEffect(() => {
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!candles || !volume) return;
    candles.setData(
      bars.map((bar) => ({
        time: alphaBusinessDay(bar.time),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    );
    volume.setData(
      bars.map((bar) => ({
        time: alphaBusinessDay(bar.time),
        value: bar.volume ?? 0,
        color:
          bar.close >= bar.open
            ? "rgba(34, 197, 94, 0.55)"
            : "rgba(239, 68, 68, 0.55)",
      })),
    );
  }, [bars]);

  useEffect(() => {
    if (visible && bars.length > 0) {
      chartRef.current?.timeScale().fitContent();
    }
  }, [bars.length, visible]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-72 w-full"
      role="img"
      aria-label={ariaLabel}
    />
  );
}
