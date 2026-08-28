/**
 * 本文件测试 Alpha 工作台持久状态、模板实例化和主标的绑定。
 * 重点锁定模板不可变、新身份生成、版本校验以及 follow/pinned 的解析结果。
 */

import {
  normalizeAlphaVtSymbol,
  type AlphaWorkstationState,
} from "@/modules/alpha/workstation/model";
import { alphaPanelRegistry } from "@/modules/alpha/workstation/panelRegistry";
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

  it("把旧图表空配置归一化为受控默认值", () => {
    const state = createDefaultAlphaWorkstationState();
    state.layout.panels[0].config = {};

    const parsed = parseAlphaWorkstationState(state, alphaPanelRegistry);

    expect(parsed?.layout.panels[0].config).toEqual({
      interval: "d",
      adjust: "forward",
      chartType: "candlestick",
    });
  });

  it("拒绝未知状态版本、非法标的和非法布局", () => {
    const state = createDefaultAlphaWorkstationState();

    expect(
      parseAlphaWorkstationState(
        { ...state, schemaVersion: 2 },
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
