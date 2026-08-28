/**
 * 本文件测试懒加载指标 Dialog 的选择、参数校验和实例提交。
 * 重点锁定客户端只编辑配置，definition 仍来自服务端查询边界。
 */

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const definitions = [
  {
    type: "sma" as const,
    pane: "main" as const,
    params: [{ key: "period", defaultValue: 20, min: 1, max: 500, step: 1 }],
    outputs: [{ id: "line", kind: "line" as const }],
    levels: [],
  },
];

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({
    data: definitions,
    isPending: false,
    isError: false,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import IndicatorDialog from "@/modules/alpha/chart/studies/IndicatorDialog";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe("IndicatorDialog", () => {
  let root: ReturnType<typeof createRoot> | null;
  let container: HTMLDivElement;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.restoreAllMocks();
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("从服务端 definition 创建实例并提交修改后的参数", () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        <IndicatorDialog
          open={true}
          editingInstanceId={null}
          instances={[]}
          onOpenChange={vi.fn()}
          onChange={onChange}
        />,
      );
    });
    const definitionButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("studies.types.sma"));
    act(() => definitionButton?.click());
    const period = document.querySelector<HTMLInputElement>(
      "#study-param-period",
    );
    act(() => {
      if (!period) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(period, "50");
      period.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const add = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "data.chart.studies.actions.add");
    act(() => add?.click());

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        instanceId: "sma-00000000-0000-4000-8000-000000000001",
        type: "sma",
        params: { period: 50 },
        styles: { line: { color: "#e0a43c", lineWidth: 2 } },
      }),
    ]);
  });
});
