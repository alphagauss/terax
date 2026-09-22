/**
 * 本文件测试 Alpha 工作台持久状态、模板实例化和主标的绑定。
 * 重点锁定模板不可变、当前版本校验、同步与图表配置边界以及 follow/pinned 的解析结果。
 */

import {
  type AlphaWorkstationState,
  normalizeAlphaVtSymbol,
} from "@/modules/alpha/workstation/model";
import { alphaPanelRegistry } from "@/modules/alpha/workstation/panelRegistry";
import {
  alphaPanelBodyHeight,
  ALPHA_PANEL_COLLAPSED_ROWS,
  ALPHA_PANEL_HEADER_HEIGHT,
} from "@/modules/alpha/workstation/panelGeometry";
import {
  parseAlphaWorkstationState,
  resolveAlphaPanelSymbol,
} from "@/modules/alpha/workstation/state";
import {
  ALPHA_WORKSTATION_TEMPLATES,
  createDefaultAlphaWorkstationState,
  instantiateAlphaWorkstationTemplate,
} from "@/modules/alpha/workstation/templates";
import { describe, expect, it } from "vitest";

function ids(prefix: string): (scope: "layout" | "panel") => string {
  let index = 0;
  return (scope) => {
    index += 1;
    return `${prefix}-${scope}-${index}`;
  };
}

describe("Alpha workstation state", () => {
  it("加密网格后模板仍保持全宽或等分宽度及原有图表内容高度", () => {
    const initial = createDefaultAlphaWorkstationState();
    for (const template of ALPHA_WORKSTATION_TEMPLATES) {
      const layout = instantiateAlphaWorkstationTemplate(template.id);
      expect(
        parseAlphaWorkstationState({ ...initial, layout }, alphaPanelRegistry),
      ).not.toBeNull();
      expect(layout.grid.reduce((sum, item) => sum + item.w, 0)).toBe(80);
      expect(
        layout.grid.every((item) => alphaPanelBodyHeight(item.h) === 540),
      ).toBe(true);
    }
    expect(alphaPanelBodyHeight(ALPHA_PANEL_COLLAPSED_ROWS)).toBe(0);
    expect(ALPHA_PANEL_HEADER_HEIGHT).toBe(29);
    expect(alphaPanelBodyHeight(ALPHA_PANEL_COLLAPSED_ROWS + 1)).toBe(15);
    expect(
      parseAlphaWorkstationState(
        { ...initial, layout: { ...initial.layout, schemaVersion: 1 } },
        alphaPanelRegistry,
      ),
    ).toBeNull();
  });
  it("从模板生成新的布局和面板身份且不修改模板", () => {
    const source = JSON.stringify(ALPHA_WORKSTATION_TEMPLATES);
    const first = instantiateAlphaWorkstationTemplate("comparison", ids("a"));
    const second = instantiateAlphaWorkstationTemplate("comparison", ids("b"));

    expect(first.id).not.toBe(second.id);
    expect(first.panels.map((panel) => panel.id)).not.toEqual(
      second.panels.map((panel) => panel.id),
    );
    expect(first.grid.map((item) => item.panelId)).toEqual(
      first.panels.map((panel) => panel.id),
    );
    expect(JSON.stringify(ALPHA_WORKSTATION_TEMPLATES)).toBe(source);
  });

  it("解析共享状态并归一化主标的和固定标的", () => {
    const state = createDefaultAlphaWorkstationState();
    const value: AlphaWorkstationState = {
      ...state,
      mainSymbol: " 000001.szse ",
      layout: {
        ...state.layout,
        panels: [
          {
            ...state.layout.panels[0],
            binding: { mode: "pinned", vtSymbol: " 600000.sse " },
          },
        ],
      },
    };

    const parsed = parseAlphaWorkstationState(value, alphaPanelRegistry);

    expect(parsed?.mainSymbol).toBe("000001.SZSE");
    expect(parsed?.layout.panels[0].binding).toEqual({
      mode: "pinned",
      vtSymbol: "600000.SSE",
    });
  });

  it("把缺失可选字段的图表配置归一化为当前默认值", () => {
    const state = createDefaultAlphaWorkstationState();
    state.layout.panels[0].config = {};

    const parsed = parseAlphaWorkstationState(state, alphaPanelRegistry);

    expect(parsed?.layout.panels[0].config).toEqual({
      interval: "d",
      adjust: "forward",
      chartType: "candlestick",
      showVolume: true,
      paneRatios: { main: 8, volume: 2 },
      realtime: false,
      studies: [],
      comparisons: [],
    });
  });

  it("解析并保留 Chart Panel 的对比标的配置", () => {
    const state = createDefaultAlphaWorkstationState();
    state.layout.panels[0].config = {
      ...state.layout.panels[0].config,
      comparisons: [{ vtSymbol: "600000.sse", color: "#d9a441" }],
    };

    const parsed = parseAlphaWorkstationState(state, alphaPanelRegistry);

    expect(parsed?.layout.panels[0].config).toMatchObject({
      comparisons: [{ vtSymbol: "600000.SSE", color: "#d9a441" }],
    });
  });

  it("拒绝版本 1 状态而不保留开发期兼容路径", () => {
    const current = createDefaultAlphaWorkstationState();
    const legacy = {
      schemaVersion: 1,
      mainSymbol: current.mainSymbol,
      locked: current.locked,
      layout: current.layout,
    };

    const parsed = parseAlphaWorkstationState(legacy, alphaPanelRegistry);

    expect(parsed).toBeNull();
    expect(legacy).not.toHaveProperty("chartSync");
  });

  it("拒绝未知状态版本、非法标的和非法布局", () => {
    const state = createDefaultAlphaWorkstationState();

    expect(
      parseAlphaWorkstationState(
        { ...state, schemaVersion: 3 },
        alphaPanelRegistry,
      ),
    ).toBeNull();
    expect(
      parseAlphaWorkstationState(
        { ...state, mainSymbol: "000001" },
        alphaPanelRegistry,
      ),
    ).toBeNull();
    expect(
      parseAlphaWorkstationState(
        { ...state, layout: { ...state.layout, grid: [] } },
        alphaPanelRegistry,
      ),
    ).toBeNull();
    expect(
      parseAlphaWorkstationState(
        {
          ...state,
          chartSync: { ...state.chartSync, runtimeRange: { from: 1, to: 2 } },
        },
        alphaPanelRegistry,
      ),
    ).toBeNull();
  });

  it("解析 follow 与 pinned 标的并校验用户输入", () => {
    expect(resolveAlphaPanelSymbol({ mode: "follow" }, "000001.SZSE")).toBe(
      "000001.SZSE",
    );
    expect(
      resolveAlphaPanelSymbol(
        { mode: "pinned", vtSymbol: "600000.SSE" },
        "000001.SZSE",
      ),
    ).toBe("600000.SSE");
    expect(normalizeAlphaVtSymbol(" 600000.sse ")).toBe("600000.SSE");
    expect(normalizeAlphaVtSymbol("600000")).toBeNull();
  });
});
