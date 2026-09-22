import { describe, expect, it } from "vitest";
import { alphaCanvasGeometry } from "@/modules/alpha/workstation/panelGeometry";

describe("Alpha 自由画布", () => {
  it("视口改变列数而非单格宽度，远端面板不会被压回视口", () => {
    const grid = [{ panelId: "chart", x: 160, y: 0, w: 40, h: 38 }];
    for (const viewport of [0, 800, 1920, 3840]) {
      const canvas = alphaCanvasGeometry(viewport, grid);
      expect(canvas.width).toBeGreaterThanOrEqual(viewport);
      expect(canvas.columns).toBeGreaterThanOrEqual(200);
      expect((canvas.gridWidth - 1) / canvas.columns).toBe(15);
    }
  });
  it("空画布也能填满视口，交互预留空间结束后不进入持久化几何", () => {
    expect(alphaCanvasGeometry(1920, [])).toEqual({
      columns: 127,
      gridWidth: 1906,
      width: 1920,
    });
    expect(alphaCanvasGeometry(800, [], 200)).toEqual({
      columns: 200,
      gridWidth: 3001,
      width: 3001,
    });
    expect(alphaCanvasGeometry(800, []).columns).toBe(53);
  });

  it("内容未超出视口时，完整列之外的余数不会产生额外滚动区域", () => {
    const grid = [{ panelId: "chart", x: 0, y: 0, w: 80, h: 38 }];
    for (const width of [1201, 1202, 1215, 1800, 1920]) {
      const canvas = alphaCanvasGeometry(width, grid);
      expect(canvas.width).toBe(width);
      expect(canvas.gridWidth).toBeLessThanOrEqual(width);
      expect(width - canvas.gridWidth).toBeLessThan(15);
    }
  });
});
