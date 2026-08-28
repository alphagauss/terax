/**
 * 本文件测试工作台图表面板对公共行情 Scene 的薄包装。
 * 重点锁定持久化配置解析、panel 密度和配置更新回传，不允许面板复制查询逻辑。
 */

// @vitest-environment happy-dom

import type { AlphaPanelProps } from "@/modules/alpha/workstation/model";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sceneProps: null as Record<string, unknown> | null,
}));

vi.mock("@/modules/alpha/chart/scenes/MarketChartScene", () => ({
  MarketChartScene: (props: Record<string, unknown>) => {
    mocks.sceneProps = props;
    return null;
  },
}));

vi.mock("@/modules/alpha/components/AlphaServiceBoundary", () => ({
  AlphaServiceBoundary: ({ children }: { children: React.ReactNode }) =>
    children,
}));

import AlphaChartPanel from "@/modules/alpha/workstation/components/AlphaChartPanel";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe("AlphaChartPanel", () => {
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.sceneProps = null;
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("把持久化配置交给公共 Scene 并回传受控更新", () => {
    const onConfigChange = vi.fn();
    const props: AlphaPanelProps = {
      panelId: "panel-1",
      vtSymbol: "000001.SZSE",
      visible: true,
      config: { interval: "1h", adjust: "none", chartType: "line" },
      onConfigChange,
    };

    act(() => root?.render(<AlphaChartPanel {...props} />));

    expect(mocks.sceneProps).toMatchObject({
      vtSymbol: "000001.SZSE",
      visible: true,
      density: "panel",
      options: { interval: "1h", adjust: "none", chartType: "line" },
    });
    act(() => {
      const change = mocks.sceneProps?.onOptionsChange as (
        value: Record<string, string>,
      ) => void;
      change({ interval: "d", adjust: "forward", chartType: "ohlc" });
    });
    expect(onConfigChange).toHaveBeenCalledWith({
      interval: "d",
      adjust: "forward",
      chartType: "ohlc",
    });
  });
});
