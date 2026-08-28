/**
 * 本文件测试对比 legend 的精确值和局部恢复操作。
 * 重点锁定主标的、百分比格式、局部覆盖、失败重试与删除互不影响。
 */

// @vitest-environment happy-dom

import { ComparisonLegend } from "@/modules/alpha/chart/comparison/ComparisonLegend";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe("ComparisonLegend", () => {
  let root: ReturnType<typeof createRoot> | null;
  let container: HTMLDivElement;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("显示主标的与精确收益，并只对失败标的提供重试", () => {
    const onRetry = vi.fn();
    const onRemove = vi.fn();
    act(() => {
      root?.render(
        <ComparisonLegend
          mainSymbol="MAIN.SSE"
          mainName="Main"
          comparisons={[
            {
              vtSymbol: "READY.SSE",
              name: "Ready",
              color: "#d9a441",
              points: [],
              status: "ready",
              partial: true,
            },
            {
              vtSymbol: "ERROR.SSE",
              name: "Error",
              color: "#a56de2",
              points: [],
              status: "error",
              partial: false,
            },
          ]}
          values={{ "MAIN.SSE": 1.25, "READY.SSE": -2.5 }}
          onManage={vi.fn()}
          onRemove={onRemove}
          onRetry={onRetry}
        />,
      );
    });

    expect(container.textContent).toContain("+1.25%");
    expect(container.textContent).toContain("-2.50%");
    expect(container.textContent).toContain(
      "data.chart.comparisons.status.partial",
    );
    const retry = container.querySelector<HTMLButtonElement>(
      '[aria-label="data.chart.comparisons.actions.retry"]',
    );
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledWith("ERROR.SSE");
    const removeButtons = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="data.chart.comparisons.actions.remove"]',
    );
    act(() => removeButtons[0]?.click());
    expect(onRemove).toHaveBeenCalledWith("READY.SSE");
  });
});
