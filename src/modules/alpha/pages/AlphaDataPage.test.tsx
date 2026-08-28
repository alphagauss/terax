/**
 * 本文件测试 Alpha 数据目录页的按需加载和手动刷新流程。
 * 重点锁定统一筛选控件、按需行情、服务端搜索，以及刷新强制绕过概览缓存。
 */

// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

const mocks = vi.hoisted(() => ({
  getAlphaDataOverview: vi.fn(),
  getAlphaSecurities: vi.fn(),
  sceneProps: null as Record<string, unknown> | null,
}));

vi.mock("@/modules/alpha/api", () => ({
  getAlphaDataOverview: mocks.getAlphaDataOverview,
  getAlphaSecurities: mocks.getAlphaSecurities,
}));

vi.mock("@/modules/alpha/components/AlphaServiceBoundary", () => ({
  AlphaServiceBoundary: ({ children }: { children: React.ReactNode }) =>
    children,
}));

vi.mock("@/modules/alpha/chart/scenes/MarketChartScene", () => ({
  MarketChartScene: (props: Record<string, unknown>) => {
    mocks.sceneProps = props;
    return createElement(
      "div",
      { "data-chart-symbol": props.vtSymbol ?? "" },
      "chart",
    );
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

import { AlphaDataPage } from "@/modules/alpha/pages/AlphaDataPage";
import { clearAlphaQueryCache } from "@/modules/alpha/query";

const overview = {
  summary: {
    security_count: 1,
    profile_count: 1,
    bar_security_count: 1,
    total_bar_count: 2,
    data_start: "2025-01-02 00:00:00",
    data_end: "2025-01-03 00:00:00",
    latest_updated_at: "2025-01-03 16:00:00",
  },
  facets: {
    exchanges: [{ value: "SZSE", count: 1 }],
    asset_types: [{ value: "stock", count: 1 }],
    data_states: [{ value: "complete", count: 1 }],
    intervals: [{ value: "d", security_count: 1, row_count: 2 }],
  },
};

const security = {
  vt_symbol: "000001.SZSE",
  symbol: "000001",
  exchange: "SZSE",
  name: "平安银行",
  asset_type: "stock",
  board: null,
  listed_date: "1991-04-03",
  delisted_date: null,
  status: "active" as const,
  data_state: "complete" as const,
  total_bar_count: 2,
  data_start: "2025-01-02 00:00:00",
  data_end: "2025-01-03 00:00:00",
  latest_updated_at: "2025-01-03 16:00:00",
  intervals: ["d"],
  coverage: {
    d: {
      start: "2025-01-02 00:00:00",
      end: "2025-01-03 00:00:00",
      rows: 2,
      updated_at: "2025-01-03 16:00:00",
    },
  },
};

describe("AlphaDataPage", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    clearAlphaQueryCache();
    mocks.getAlphaDataOverview.mockReset().mockResolvedValue(overview);
    mocks.getAlphaSecurities.mockReset().mockResolvedValue({
      items: [security],
      total: 1,
      limit: 50,
      offset: 0,
    });
    mocks.sceneProps = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("打开页面不选择行情，选择证券后把标的交给公共图表 scene", async () => {
    const container = document.createElement("div");
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(AlphaDataPage, { visible: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.getAlphaSecurities).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, offset: 0 }),
    );
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(4);
    expect(container.querySelector("[data-chart-symbol='']")).not.toBeNull();
    expect(mocks.sceneProps).toMatchObject({
      density: "compact",
      options: {
        interval: "d",
        adjust: "forward",
        chartType: "candlestick",
      },
    });

    const symbolButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "000001.SZSE",
    );
    expect(symbolButton).toBeDefined();
    await act(async () => {
      symbolButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector("[data-chart-symbol='000001.SZSE']"),
      ).not.toBeNull();
    });
  });

  it("搜索使用防抖服务端查询，手动刷新强制绕过概览缓存", async () => {
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(AlphaDataPage, { visible: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const input = container.querySelector("input");
    await act(async () => {
      if (input) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        valueSetter?.call(input, "平安");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(mocks.getAlphaSecurities).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "平安", offset: 0 }),
    );

    const refresh = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "common.refresh",
    );
    await act(async () => {
      refresh?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.getAlphaDataOverview).toHaveBeenLastCalledWith(true);
  });
});
