/**
 * 本文件测试侧边栏拖放的纯位置计算。
 * 横向和纵向导航必须使用相同的中点插入规则。
 */

import { describe, expect, it } from "vitest";
import { sidebarDropLocationForPoint, sidebarGapForPoint } from "./dragSession";

const rects = [
  { left: 0, top: 0, width: 40, height: 40 },
  { left: 40, top: 40, width: 40, height: 40 },
];

describe("sidebarGapForPoint", () => {
  it("resolves vertical gaps from item midpoints", () => {
    expect(sidebarGapForPoint(rects, "vertical", 10, 10)).toBe(0);
    expect(sidebarGapForPoint(rects, "vertical", 10, 30)).toBe(1);
    expect(sidebarGapForPoint(rects, "vertical", 10, 90)).toBe(2);
  });

  it("resolves horizontal gaps from item midpoints", () => {
    expect(sidebarGapForPoint(rects, "horizontal", 10, 10)).toBe(0);
    expect(sidebarGapForPoint(rects, "horizontal", 30, 10)).toBe(1);
    expect(sidebarGapForPoint(rects, "horizontal", 90, 10)).toBe(2);
  });
});

describe("sidebarDropLocationForPoint", () => {
  const regions = [
    {
      location: "primary" as const,
      barRect: { left: 0, right: 48, top: 0, bottom: 600 },
      zoneRect: { left: 48, right: 300, top: 0, bottom: 600 },
    },
    {
      location: "secondary" as const,
      barRect: { left: 900, right: 1200, top: 0, bottom: 36 },
      zoneRect: { left: 900, right: 1200, top: 0, bottom: 600 },
    },
  ];

  it("uses the whole destination sidebar for cross-sidebar dragging", () => {
    expect(sidebarDropLocationForPoint(regions, "primary", 960, 104)).toBe(
      "secondary",
    );
    expect(sidebarDropLocationForPoint(regions, "secondary", 200, 104)).toBe(
      "primary",
    );
  });

  it("keeps same-sidebar reordering limited to its navigation bar", () => {
    expect(
      sidebarDropLocationForPoint(regions, "primary", 200, 104),
    ).toBeNull();
    expect(
      sidebarDropLocationForPoint(regions, "secondary", 960, 104),
    ).toBeNull();
  });
});
