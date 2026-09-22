/**
 * 本文件测试 Alpha Panel Registry 的注册和懒加载边界。
 * 重点锁定重复类型、尺寸约束，以及枚举元数据时不能执行面板 loader。
 */

import type { AlphaPanelDescriptor } from "@/modules/alpha/workstation/registry";
import { createAlphaPanelRegistry } from "@/modules/alpha/workstation/registry";
import { describe, expect, it, vi } from "vitest";

function descriptor(
  type: string,
  load = vi.fn(async () => ({ default: () => null })),
): AlphaPanelDescriptor {
  return {
    type,
    titleKey: `workstation.panels.${type}`,
    category: "market",
    singleton: false,
    pinnable: true,
    defaultSize: { w: 8, h: 8, minW: 4, minH: 4 },
    createDefaultConfig: () => ({}),
    validateConfig: () => ({}),
    load,
  };
}

describe("Alpha Panel Registry", () => {
  it("枚举和查找元数据时不加载实现并保持组件身份", () => {
    const load = vi.fn(async () => ({ default: () => null }));
    const registry = createAlphaPanelRegistry([descriptor("chart", load)]);

    const fromLookup = registry.get("chart");
    const fromList = registry.list()[0];

    expect(load).not.toHaveBeenCalled();
    expect(fromLookup).toBe(fromList);
    expect(registry.list()).toBe(registry.list());
    expect(fromLookup?.Component).toBe(fromList.Component);
  });

  it("拒绝重复面板类型", () => {
    expect(() =>
      createAlphaPanelRegistry([descriptor("chart"), descriptor("chart")]),
    ).toThrow("Duplicate Alpha panel type: chart");
  });

  it("拒绝会与布局归一化结果不一致的空白标识符", () => {
    expect(() => createAlphaPanelRegistry([descriptor(" chart")])).toThrow(
      "Alpha panel type and title key must not have surrounding whitespace",
    );
  });

  it("拒绝小于最小值的默认尺寸", () => {
    expect(() =>
      createAlphaPanelRegistry([
        {
          ...descriptor("chart"),
          defaultSize: { w: 8, h: 4, minW: 6, minH: 5 },
        },
      ]),
    ).toThrow("Invalid default size for Alpha panel type: chart");
  });

  it("面板默认宽度不再受固定画布列数约束", () => {
    const registry = createAlphaPanelRegistry([
      {
        ...descriptor("wide"),
        defaultSize: { w: 200, h: 8, minW: 100, minH: 4 },
      },
    ]);
    expect(registry.get("wide")?.defaultSize.w).toBe(200);
  });
});
