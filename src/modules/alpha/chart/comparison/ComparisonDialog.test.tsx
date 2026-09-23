/**
 * 本文件测试对比标的管理对话框的有界证券选择。
 * 重点锁定主标的和已选标的排除、三标的上限以及颜色配置回传。
 */

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const securities = [
  { vt_symbol: "MAIN.SSE", name: "Main" },
  { vt_symbol: "SELECTED.SSE", name: "Selected" },
  { vt_symbol: "CANDIDATE.SSE", name: "Candidate" },
];

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({
    data: { items: securities },
    isPending: false,
    isError: false,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { symbol?: string }) =>
      values?.symbol ? `${key}:${values.symbol}` : key,
  }),
}));

import ComparisonDialog from "@/modules/alpha/chart/comparison/ComparisonDialog";
import { WorkbenchPageScope } from "@/modules/workbench/WorkbenchPageOverlays";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe("ComparisonDialog", () => {
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

  it("排除主标的和已选标的，并为新增标的分配未使用颜色", () => {
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    act(() => {
      root?.render(
        <WorkbenchPageScope visible focused>
          <ComparisonDialog
            open={true}
            mainSymbol="MAIN.SSE"
            interval="d"
            comparisons={[{ vtSymbol: "SELECTED.SSE", color: "#4daafc" }]}
            onOpenChange={onOpenChange}
            onChange={onChange}
          />
        </WorkbenchPageScope>,
      );
    });

    const candidate = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("CANDIDATE.SSE"));
    expect(document.body.textContent).not.toContain("MainMAIN.SSE");
    expect(document.body.textContent).not.toContain("SelectedSELECTED.SSE");
    expect(document.body.textContent).not.toContain("Close");
    act(() => candidate?.click());

    expect(onChange).toHaveBeenCalledWith([
      { vtSymbol: "SELECTED.SSE", color: "#4daafc" },
      { vtSymbol: "CANDIDATE.SSE", color: "#d9a441" },
    ]);
    const backdrop = container.querySelector("[data-workbench-page-backdrop]");
    expect(backdrop).not.toBeNull();
    act(() => {
      backdrop?.dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, bubbles: true }),
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("达到三个标的后禁用新增，并回传合法颜色修改", () => {
    const onChange = vi.fn();
    const comparisons = [
      { vtSymbol: "A.SSE", color: "#4daafc" },
      { vtSymbol: "B.SSE", color: "#d9a441" },
      { vtSymbol: "C.SSE", color: "#a56de2" },
    ];
    act(() => {
      root?.render(
        <WorkbenchPageScope visible focused>
          <ComparisonDialog
            open={true}
            mainSymbol="MAIN.SSE"
            interval="d"
            comparisons={comparisons}
            onOpenChange={vi.fn()}
            onChange={onChange}
          />
        </WorkbenchPageScope>,
      );
    });

    const candidate = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("CANDIDATE.SSE"));
    expect(candidate?.disabled).toBe(true);
    const color = document.querySelector<HTMLInputElement>(
      '[aria-label="data.chart.comparisons.dialog.color:A.SSE"]',
    );
    act(() => {
      if (!color) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(color, "#123456");
      color.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith([
      { vtSymbol: "A.SSE", color: "#123456" },
      comparisons[1],
      comparisons[2],
    ]);
  });
});
