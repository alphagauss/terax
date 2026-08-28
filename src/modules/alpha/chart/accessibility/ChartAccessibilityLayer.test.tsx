/**
 * 本文件测试 Alpha 图表的 Canvas 外可访问数据层。
 * 重点锁定礼貌摘要、国际化表头和最多二十行的 DOM 上限。
 */

// @vitest-environment happy-dom

import { ChartAccessibilityLayer } from "@/modules/alpha/chart/accessibility/ChartAccessibilityLayer";
import type { MarketBar } from "@/modules/alpha/market/model";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

function marketBar(day: number): MarketBar {
  return {
    time: {
      kind: "trading-day",
      date: `2026-08-${String(day).padStart(2, "0")}`,
    },
    open: day,
    high: day + 2,
    low: day - 1,
    close: day + 1,
    volume: day * 100,
    amount: null,
    openInterest: null,
  };
}

describe("ChartAccessibilityLayer", () => {
  let root: ReturnType<typeof createRoot> | null;
  let container: HTMLDivElement;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("发布摘要并只渲染最近二十根 K 线", () => {
    const rows = Array.from({ length: 25 }, (_, index) => marketBar(index + 1));
    act(() => {
      root?.render(
        <ChartAccessibilityLayer
          summary="000001.SZSE 2026-08-25 close 26.00"
          rows={rows}
          formatTime={(time) =>
            time.kind === "trading-day" ? time.date : String(time.epochSeconds)
          }
          formatPrice={(value) => value.toFixed(2)}
          formatVolume={(value) => (value === null ? "-" : String(value))}
        />,
      );
    });

    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "000001.SZSE 2026-08-25 close 26.00",
    );
    expect(container.querySelector("summary")?.textContent).toBe(
      "data.chart.accessibility.openTable",
    );
    const bodyRows = container.querySelectorAll("tbody tr");
    expect(bodyRows).toHaveLength(20);
    expect(bodyRows[0]?.textContent).toContain("2026-08-06");
    expect(bodyRows[19]?.textContent).toContain("2026-08-25");
    expect(container.querySelectorAll('th[scope="col"]')).toHaveLength(6);
  });
});
