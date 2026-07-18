import { zoneForPoint } from "@/modules/workbench/dragSession";
import { describe, expect, it } from "vitest";

const rect = {
  left: 100,
  right: 500,
  top: 100,
  bottom: 300,
  width: 400,
  height: 200,
};

describe("zoneForPoint", () => {
  it("selects each edge and the center", () => {
    expect(zoneForPoint(rect, 105, 200)).toBe("left");
    expect(zoneForPoint(rect, 495, 200)).toBe("right");
    expect(zoneForPoint(rect, 300, 105)).toBe("up");
    expect(zoneForPoint(rect, 300, 295)).toBe("down");
    expect(zoneForPoint(rect, 300, 200)).toBe("center");
  });

  it("uses a ten-percent split threshold", () => {
    expect(zoneForPoint(rect, 139, 200)).toBe("left");
    expect(zoneForPoint(rect, 141, 200)).toBe("center");
    expect(zoneForPoint(rect, 300, 119)).toBe("up");
    expect(zoneForPoint(rect, 300, 121)).toBe("center");
  });

  it("resolves corners using the side-by-side split preference", () => {
    expect(zoneForPoint(rect, 105, 105)).toBe("left");
    expect(zoneForPoint(rect, 495, 295)).toBe("right");
    expect(zoneForPoint(rect, 300, 105)).toBe("up");
    expect(zoneForPoint(rect, 300, 295)).toBe("down");
  });
});
