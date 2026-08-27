/**
 * 本文件测试 Alpha 公共金融图表外壳的基础交互。
 * 重点锁定重置命令传递，以及涨跌幅必须使用上一根 K 线收盘价计算。
 */

// @vitest-environment happy-dom

import type { MarketBar } from "@/modules/alpha/market/model";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chartProps: null as Record<string, unknown> | null,
}));

vi.mock("@/modules/alpha/chart/components/FinancialChart", () => ({
  FinancialChart: (props: Record<string, unknown>) => {
    mocks.chartProps = props;
    return createElement("div", { "data-testid": "financial-chart" });
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

import { FinancialChartFrame } from "@/modules/alpha/chart/components/FinancialChartFrame";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

function marketBar(date: string, open: number, close: number): MarketBar {
  return {
    time: { kind: "trading-day", date },
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 100,
    amount: 1_000,
    openInterest: null,
  };
}

describe("FinancialChartFrame", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.chartProps = null;
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("按上一根收盘价显示涨跌幅，并向图表传递重置命令", () => {
    const bars = [
      marketBar("2026-07-29", 9, 10),
      marketBar("2026-07-30", 20, 11),
    ];
    act(() => {
      root?.render(
        createElement(FinancialChartFrame, {
          bars,
          dataKey: "000001.SZSE|d|forward",
          symbol: "000001.SZSE",
          chartType: "candlestick",
          status: "ready",
          historyError: false,
          hasMoreBefore: false,
          loadingMore: false,
          visible: true,
          onChartTypeChange: vi.fn(),
          onRequestMore: vi.fn(),
          onRetry: vi.fn(),
        }),
      );
    });

    expect(container.textContent).toContain("10.00%");
    expect(mocks.chartProps?.resetRevision).toBe(0);

    act(() => {
      const onCrosshairChange = mocks.chartProps?.onCrosshairChange as (
        bar: MarketBar,
      ) => void;
      onCrosshairChange({ ...bars[1] });
    });
    expect(container.textContent).toContain("10.00%");

    const reset = container.querySelector<HTMLButtonElement>(
      '[aria-label="data.chart.resetView"]',
    );
    act(() => reset?.click());

    expect(mocks.chartProps?.resetRevision).toBe(1);
  });
});
