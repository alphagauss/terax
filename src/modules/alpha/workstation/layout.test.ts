/**
 * 本文件测试 Alpha 工作台布局的结构和语义校验。
 * 重点锁定版本、身份、24 列几何、singleton、未知类型和纯 JSON 配置不变量。
 */

import type { AlphaWorkstationLayout } from "@/modules/alpha/workstation/model";
import {
  parseAlphaWorkstationLayout,
  updateAlphaPanelConfig,
} from "@/modules/alpha/workstation/layout";
import {
  createAlphaPanelRegistry,
  type AlphaPanelDescriptor,
} from "@/modules/alpha/workstation/registry";
import { describe, expect, it } from "vitest";

function descriptor(type: string, singleton = false): AlphaPanelDescriptor {
  return {
    type,
    titleKey: `workstation.panels.${type}`,
    category: "market",
    singleton,
    pinnable: true,
    defaultSize: { w: 8, h: 8, minW: 4, minH: 4 },
    createDefaultConfig: () => ({ interval: "d" }),
    validateConfig(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("interval" in value) ||
        typeof value.interval !== "string"
      ) {
        throw new Error("invalid config");
      }
      return { interval: value.interval.trim() };
    },
    load: async () => ({ default: () => null }),
  };
}

const registry = createAlphaPanelRegistry([
  descriptor("chart"),
  descriptor("watchlist", true),
]);

function validLayout(): AlphaWorkstationLayout {
  return {
    schemaVersion: 1,
    id: "layout-1",
    name: "Default",
    panels: [
      {
        id: "panel-chart",
        type: "chart",
        binding: { mode: "follow" },
        config: { interval: " d " },
      },
      {
        id: "panel-watchlist",
        type: "watchlist",
        binding: { mode: "pinned", vtSymbol: "000001.SZSE" },
        config: { interval: "d" },
      },
    ],
    grid: [
      { panelId: "panel-chart", x: 0, y: 0, w: 12, h: 8 },
      { panelId: "panel-watchlist", x: 12, y: 0, w: 6, h: 8 },
    ],
  };
}

function issueCodes(value: unknown) {
  const result = parseAlphaWorkstationLayout(value, registry);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("Alpha workstation layout", () => {
  it("接受有效布局并使用 descriptor 归一化配置", () => {
    const result = parseAlphaWorkstationLayout(validLayout(), registry);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layout.panels[0].config).toEqual({ interval: "d" });
  });

  it("拒绝未知 schema 版本和非法结构", () => {
    expect(issueCodes({ ...validLayout(), schemaVersion: 2 })).toContain(
      "schema-version",
    );
    expect(issueCodes({ schemaVersion: 1 })).toContain("structure");
  });

  it("拒绝重复身份以及 panel/grid 不对应", () => {
    const duplicate = validLayout();
    duplicate.panels.push({ ...duplicate.panels[0] });
    expect(issueCodes(duplicate)).toContain("duplicate-panel-id");

    const mismatched = validLayout();
    mismatched.grid = [
      mismatched.grid[0],
      { panelId: "orphan", x: 0, y: 20, w: 4, h: 4 },
    ];
    expect(issueCodes(mismatched)).toEqual(
      expect.arrayContaining(["missing-grid-item", "orphan-grid-item"]),
    );
  });

  it("拒绝 24 列越界、尺寸不足和面板重叠", () => {
    const invalid = validLayout();
    invalid.grid[0] = { panelId: "panel-chart", x: 22, y: 0, w: 3, h: 3 };
    invalid.grid[1] = {
      panelId: "panel-watchlist",
      x: 22,
      y: 0,
      w: 4,
      h: 8,
    };

    expect(issueCodes(invalid)).toEqual(
      expect.arrayContaining([
        "grid-bounds",
        "panel-min-size",
        "panel-overlap",
      ]),
    );
  });

  it("拒绝 singleton 面板的重复实例", () => {
    const invalid = validLayout();
    invalid.panels.push({
      ...invalid.panels[1],
      id: "panel-watchlist-2",
    });
    invalid.grid.push({
      panelId: "panel-watchlist-2",
      x: 18,
      y: 0,
      w: 6,
      h: 8,
    });

    expect(issueCodes(invalid)).toContain("singleton");
  });

  it("拒绝 descriptor 无法解析或不是纯 JSON 的配置", () => {
    const invalidKnown = validLayout();
    invalidKnown.panels[0].config = { interval: 1 };
    expect(issueCodes(invalidKnown)).toContain("invalid-config");

    const invalidJson = validLayout() as unknown as {
      panels: Array<{ type: string; config: Record<string, unknown> }>;
    };
    invalidJson.panels[0].type = "future-panel";
    invalidJson.panels[0].config = { callback: undefined };
    expect(issueCodes(invalidJson)).toContain("invalid-config");
  });

  it("保留未知面板供挂载层显示可恢复占位", () => {
    const layout = validLayout();
    layout.panels[0].type = "future-panel";
    layout.panels[0].config = { source: "saved-layout" };

    const result = parseAlphaWorkstationLayout(layout, registry);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layout.panels[0]).toMatchObject({
      type: "future-panel",
      config: { source: "saved-layout" },
    });
  });

  it("只更新目标面板的已归一化配置", () => {
    const layout = validLayout();
    const untouchedPanel = layout.panels[1];
    const next = updateAlphaPanelConfig(
      layout,
      "panel-chart",
      { interval: " 1h " },
      registry,
    );

    expect(next).not.toBe(layout);
    expect(next.grid).toBe(layout.grid);
    expect(next.panels[0]).toMatchObject({
      id: "panel-chart",
      binding: { mode: "follow" },
      config: { interval: "1h" },
    });
    expect(next.panels[1]).toBe(untouchedPanel);
    expect(
      updateAlphaPanelConfig(layout, "panel-chart", { interval: 1 }, registry),
    ).toBe(layout);
  });
});
