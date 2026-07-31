/**
 * 本文件实现 Alpha 统计图表的轻量 ECharts 适配层。
 * 统一处理按需注册、主题色、容器尺寸变化和页面可见性，不保存业务数据。
 */

import { BarChart, LineChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import {
  init,
  type EChartsCoreOption,
  type EChartsType,
  use,
} from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import { useTheme } from "@/modules/theme";

use([
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export type AlphaChartPalette = {
  muted: string;
  border: string;
  colors: string[];
};

type Props = {
  visible: boolean;
  ariaLabel: string;
  createOption: (palette: AlphaChartPalette) => EChartsCoreOption;
};

function readColor(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
}

/**
 * 渲染一个跟随 Terax 主题和 Workbench 可见性的 Canvas 图表。
 *
 * 页面隐藏期间保留实例，重新显示后只同步最终容器尺寸。
 */
export function AlphaEChart({ visible, ariaLabel, createOption }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const visibleRef = useRef(visible);
  const { resolvedMode, themeId } = useTheme();

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = init(container, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const observer = new ResizeObserver(() => {
      if (visibleRef.current) chart.resize();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // 主题色来自 CSS 变量，这两个值仅用于在主题切换完成后触发重新读取。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 不能从 getComputedStyle 推导主题依赖。
  useEffect(() => {
    const container = containerRef.current;
    const chart = chartRef.current;
    if (!container || !chart) return;
    const style = getComputedStyle(container);
    const palette: AlphaChartPalette = {
      muted: readColor(style, "--muted-foreground"),
      border: readColor(style, "--border"),
      colors: [1, 2, 3, 4, 5].map((index) =>
        readColor(style, `--chart-${index}`),
      ),
    };
    chart.setOption(createOption(palette), { notMerge: true });
  }, [createOption, resolvedMode, themeId]);

  useEffect(() => {
    if (visible) chartRef.current?.resize();
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-52 w-full"
      role="img"
      aria-label={ariaLabel}
    />
  );
}
