/**
 * 本文件提供 Alpha 公共金融图表的 React 宿主。
 * 组件只桥接受控输入、主题、可见性和 DOM 尺寸，运行时命令由 Controller 持有。
 */

import { FinancialChartController } from "@/modules/alpha/chart/controller/FinancialChartController";
import type {
  FinancialChartPalette,
  FinancialChartType,
} from "@/modules/alpha/chart/model";
import type { MarketBar } from "@/modules/alpha/market/model";
import { useTheme } from "@/modules/theme";
import { useEffect, useRef } from "react";

type Props = {
  bars: readonly MarketBar[];
  dataKey: string;
  chartType: FinancialChartType;
  visible: boolean;
  hasMoreBefore: boolean;
  loadingMore: boolean;
  ariaLabel: string;
  onCrosshairChange: (bar: MarketBar | null) => void;
  onRequestMore: () => void;
};

function cssColor(container: HTMLElement, name: string): string {
  return getComputedStyle(container).getPropertyValue(name).trim();
}

function readPalette(container: HTMLElement): FinancialChartPalette {
  return {
    text: cssColor(container, "--muted-foreground"),
    grid: cssColor(container, "--border"),
    border: cssColor(container, "--border"),
    crosshair: cssColor(container, "--muted-foreground"),
    up: cssColor(container, "--success"),
    down: cssColor(container, "--destructive"),
    line: cssColor(container, "--chart-1"),
  };
}

/** 渲染并稳定持有一个 Lightweight Charts 实例。 */
export function FinancialChart({
  bars,
  dataKey,
  chartType,
  visible,
  hasMoreBefore,
  loadingMore,
  ariaLabel,
  onCrosshairChange,
  onRequestMore,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<FinancialChartController | null>(null);
  const { resolvedMode, themeId } = useTheme();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = new FinancialChartController(container);
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setCallbacks({
      onCrosshairChange,
      onRequestMore,
    });
  }, [onCrosshairChange, onRequestMore]);

  useEffect(() => {
    controllerRef.current?.setChartType(chartType);
  }, [chartType]);

  useEffect(() => {
    controllerRef.current?.setBars(dataKey, bars);
  }, [bars, dataKey]);

  useEffect(() => {
    controllerRef.current?.setHistoryState(hasMoreBefore, loadingMore);
  }, [hasMoreBefore, loadingMore]);

  useEffect(() => {
    controllerRef.current?.setVisible(visible);
    if (!visible) return;
    const frame = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (container) {
        controllerRef.current?.resize(
          container.clientWidth,
          container.clientHeight,
        );
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visible]);

  // 主题色来自 CSS 变量，只在主题切换完成后重新读取并应用。
  // biome-ignore lint/correctness/useExhaustiveDependencies: CSS 变量值无法直接进入依赖数组。
  useEffect(() => {
    const container = containerRef.current;
    if (container) controllerRef.current?.applyTheme(readPalette(container));
  }, [resolvedMode, themeId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      controllerRef.current?.resize(
        container.clientWidth,
        container.clientHeight,
      );
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-72 w-full"
      role="img"
      aria-label={ariaLabel}
      data-alpha-financial-chart="true"
    />
  );
}
