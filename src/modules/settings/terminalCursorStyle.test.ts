/**
 * 本文件测试终端光标样式的持久化值归一化。
 * 非法或旧版本未知值必须回退到下游原有的方块光标。
 */

import { describe, expect, it } from "vitest";
import { coerceTerminalCursorStyle } from "./store";

describe("coerceTerminalCursorStyle", () => {
  it("保留 xterm 支持的光标样式", () => {
    for (const style of ["bar", "block", "underline"]) {
      expect(coerceTerminalCursorStyle(style)).toBe(style);
    }
  });

  it("非法持久化值回退到方块光标", () => {
    expect(coerceTerminalCursorStyle("outline")).toBe("block");
    expect(coerceTerminalCursorStyle(1)).toBe("block");
    expect(coerceTerminalCursorStyle(null)).toBe("block");
  });
});
