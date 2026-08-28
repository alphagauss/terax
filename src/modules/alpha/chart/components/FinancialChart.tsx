/**
 * 本文件提供 Alpha 公共金融图表的 React 宿主。
 * 组件桥接受控元数据、pane 配置、主题、可见性和 DOM 尺寸，并通过稳定 handle 暴露命令。
 */

import { FinancialChartController } from "@/modules/alpha/chart/controller/FinancialChartController";
import { addChartScreenshotBackground } from "@/modules/alpha/chart/export/chartExport";
import type {
  ChartMarketMetadata,
  ChartPriceReference,
  FinancialChartPalette,
  FinancialChartType,
  PaneRatios,
} from "@/modules/alpha/chart/model";
import type { MarketBar } from "@/modules/alpha/market/model";
import { marketDirectionColors } from "@/modules/alpha/market/metadata";
import { useTheme } from "@/modules/theme";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

type Props = {
  bars: readonly MarketBar[];
  dataKey: string;
  chartType: FinancialChartType;
  metadata: ChartMarketMetadata | null;
  priceReference: ChartPriceReference;
  previousCloseLabel: string;
  locale: string;
  showVolume: boolean;
  paneRatios: PaneRatios;
  visible: boolean;
  hasMoreBefore: boolean;
  loadingMore: boolean;
  ariaLabel: string;
  onCrosshairChange: (bar: MarketBar | null) => void;
  onRequestMore: () => void;
  onPaneRatiosChange?: (ratios: PaneRatios) => void;
};

/** 提供不暴露 Lightweight Charts 实例的稳定图表命令。 */
export type FinancialChartHandle = {
  resetView(): void;
  takeScreenshot(): HTMLCanvasElement | null;
};

function cssColor(container: HTMLElement, name: string): string {
  return getComputedStyle(container).getPropertyValue(name).trim();
}

function readPalette(
  container: HTMLElement,
  metadata: ChartMarketMetadata | null,
): FinancialChartPalette {
  const direction = marketDirectionColors(
    cssColor(container, "--success"),
    cssColor(container, "--destructive"),
    metadata?.priceColorConvention ?? "up-green",
  );
  return {
    text: cssColor(container, "--muted-foreground"),
    grid: cssColor(container, "--border"),
    border: cssColor(container, "--border"),
    crosshair: cssColor(container, "--muted-foreground"),
    ...direction,
    line: cssColor(container, "--chart-1"),
  };
}

/** 渲染并稳定持有一个 Lightweight Charts 实例，命令不会暴露底层图表对象。 */
export const FinancialChart = forwardRef<FinancialChartHandle, Props>(
  function FinancialChart(
    {
      bars,
      dataKey,
      chartType,
      metadata,
      priceReference,
      previousCloseLabel,
      locale,
      showVolume,
      paneRatios,
      visible,
      hasMoreBefore,
      loadingMore,
      ariaLabel,
      onCrosshairChange,
      onRequestMore,
      onPaneRatiosChange,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const controllerRef = useRef<FinancialChartController | null>(null);
    const { resolvedMode, themeId } = useTheme();

    useImperativeHandle(
      ref,
      () => ({
        resetView: () => controllerRef.current?.resetView(),
        takeScreenshot: () => {
          const container = containerRef.current;
          const controller = controllerRef.current;
          if (!container || !controller) return null;
          const screenshot = controller.takeScreenshot();
          const background = cssColor(container, "--background") || "#ffffff";
          return addChartScreenshotBackground(screenshot, background);
        },
      }),
      [],
    );

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
      controllerRef.current?.setMarketMetadata(metadata, locale);
    }, [locale, metadata]);

    useEffect(() => {
      controllerRef.current?.setPriceReference(
        priceReference,
        previousCloseLabel,
      );
    }, [previousCloseLabel, priceReference]);

    useEffect(() => {
      controllerRef.current?.setPaneRatios(paneRatios);
    }, [paneRatios]);

    useEffect(() => {
      controllerRef.current?.setShowVolume(showVolume);
    }, [showVolume]);

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
      if (container) {
        controllerRef.current?.applyTheme(readPalette(container, metadata));
      }
    }, [resolvedMode, themeId, metadata?.priceColorConvention]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container || !onPaneRatiosChange) return;
      const handlePointerUp = () => {
        const next = controllerRef.current?.getPaneRatios();
        if (!next) return;
        const keys = new Set([
          ...Object.keys(paneRatios),
          ...Object.keys(next),
        ]);
        const changed = [...keys].some(
          (key) => Math.abs((paneRatios[key] ?? 0) - (next[key] ?? 0)) > 0.01,
        );
        if (changed) onPaneRatiosChange(next);
      };
      container.addEventListener("pointerup", handlePointerUp);
      return () => container.removeEventListener("pointerup", handlePointerUp);
    }, [onPaneRatiosChange, paneRatios]);

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
        className="h-full min-h-0 w-full"
        role="img"
        aria-label={ariaLabel}
        data-alpha-financial-chart="true"
      />
    );
  },
);
