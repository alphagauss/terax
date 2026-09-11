// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { nativeDropElementAt } from "@/lib/nativeFileDrop";

it("物理坐标即使未超出视口，也按 DPI 转为 CSS 坐标，避免跨接收区误命中", () => {
  const hit = document.createElement("div");
  const point = vi.spyOn(document, "elementFromPoint").mockReturnValue(hit);
  const scale = vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
  try {
    expect(nativeDropElementAt(300, 200)).toBe(hit);
    expect(point).toHaveBeenCalledWith(150, 100);
    scale.mockReturnValue(1);
    nativeDropElementAt(300, 200);
    expect(point).toHaveBeenLastCalledWith(300, 200);
  } finally {
    vi.restoreAllMocks();
  }
});
