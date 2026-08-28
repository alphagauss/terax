/**
 * 本文件测试公共金融图表 React 宿主的实例生命周期。
 * 重点锁定受控类型和数据键切换只更新同一个 Controller，不重建图表实例。
 */

// @vitest-environment happy-dom

import type { MarketBar } from "@/modules/alpha/market/model";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createController: vi.fn(),
  controller: {
    setCallbacks: vi.fn(),
    setChartType: vi.fn(),
    setMarketMetadata: vi.fn(),
    setPriceReference: vi.fn(),
    setPaneRatios: vi.fn(),
    getPaneRatios: vi.fn(() => ({ main: 8, volume: 2 })),
    setShowVolume: vi.fn(),
    setBars: vi.fn(),
    setHistoryState: vi.fn(),
    resetView: vi.fn(),
    setVisible: vi.fn(),
    resize: vi.fn(),
    applyTheme: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("@/modules/alpha/chart/controller/FinancialChartController", () => {
  function MockFinancialChartController(
    this: Record<string, unknown>,
    container: HTMLElement,
  ) {
    mocks.createController(container);
    Object.assign(this, mocks.controller);
  }
  return { FinancialChartController: MockFinancialChartController };
});

vi.mock("@/modules/theme", () => ({
  useTheme: () => ({ resolvedMode: "dark", themeId: "modern" }),
}));

import { FinancialChart } from "@/modules/alpha/chart/components/FinancialChart";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

const bar: MarketBar = {
  time: { kind: "trading-day", date: "2026-07-30" },
  open: 10,
  high: 11,
  low: 9,
  close: 10.5,
  volume: 100,
  amount: 1_000,
  openInterest: null,
};

describe("FinancialChart", () => {
  let root: ReturnType<typeof createRoot> | null;
  let container: HTMLDivElement;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.unstubAllGlobals();
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("切换受控配置时复用同一个 Controller", () => {
    const common = {
      bars: [bar],
      visible: true,
      hasMoreBefore: false,
      loadingMore: false,
      resetRevision: 0,
      ariaLabel: "chart",
      locale: "zh-CN",
      metadata: {
        vtSymbol: "000001.SZSE",
        name: "平安银行",
        exchange: "SZSE",
        timezone: "Asia/Shanghai",
        minMove: 0.01,
        pricePrecision: 2,
        volumeUnit: "share",
        priceColorConvention: "up-red" as const,
        intervals: ["d" as const],
      },
      priceReference: {
        previousClose: 10,
        referenceTime: { kind: "trading-day" as const, date: "2026-07-29" },
      },
      previousCloseLabel: "昨收",
      showVolume: true,
      paneRatios: { main: 8, volume: 2 },
      onPaneRatiosChange: vi.fn(),
      onCrosshairChange: vi.fn(),
      onRequestMore: vi.fn(),
    };

    act(() =>
      root?.render(
        <FinancialChart
          {...common}
          dataKey="000001.SZSE|d|forward"
          chartType="candlestick"
        />,
      ),
    );
    act(() =>
      root?.render(
        <FinancialChart
          {...common}
          dataKey="000001.SZSE|1h|none"
          chartType="line"
        />,
      ),
    );

    expect(mocks.createController).toHaveBeenCalledTimes(1);
    expect(mocks.controller.setChartType).toHaveBeenLastCalledWith("line");
    expect(mocks.controller.setBars).toHaveBeenLastCalledWith(
      "000001.SZSE|1h|none",
      [bar],
    );
    expect(mocks.controller.setMarketMetadata).toHaveBeenLastCalledWith(
      common.metadata,
      "zh-CN",
    );
    expect(mocks.controller.setPriceReference).toHaveBeenLastCalledWith(
      common.priceReference,
      "昨收",
    );
  });

  it("只在 pointerup 后提交一次变化的语义 pane 比例", () => {
    const onPaneRatiosChange = vi.fn();
    const common = {
      bars: [bar],
      dataKey: "000001.SZSE|d|forward",
      chartType: "candlestick" as const,
      visible: true,
      hasMoreBefore: false,
      loadingMore: false,
      resetRevision: 0,
      ariaLabel: "chart",
      locale: "zh-CN",
      metadata: null,
      priceReference: { previousClose: null, referenceTime: null },
      previousCloseLabel: "昨收",
      showVolume: true,
      paneRatios: { main: 8, volume: 2 },
      onCrosshairChange: vi.fn(),
      onRequestMore: vi.fn(),
      onPaneRatiosChange,
    };
    act(() => root?.render(<FinancialChart {...common} />));
    const host = container.querySelector<HTMLElement>(
      "[data-alpha-financial-chart]",
    );

    act(() => host?.dispatchEvent(new PointerEvent("pointerup")));
    expect(onPaneRatiosChange).not.toHaveBeenCalled();

    mocks.controller.getPaneRatios.mockReturnValue({ main: 7, volume: 3 });
    act(() => host?.dispatchEvent(new PointerEvent("pointerup")));
    expect(onPaneRatiosChange).toHaveBeenCalledOnce();
    expect(onPaneRatiosChange).toHaveBeenCalledWith({ main: 7, volume: 3 });
  });
});
