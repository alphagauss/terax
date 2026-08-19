/**
 * 本文件测试自定义主题起始模板的完整性。
 * 锁定新主题复制 Modern Dark 全部字段，且不会共享可变的颜色和 ANSI 容器。
 */

import { describe, expect, it } from "vitest";
import { TERMINAL_BASE_KEYS, THEME_COLOR_KEYS } from "./themeRegistry";
import { starterTheme } from "./themeFiles";
import { darkModernVariant } from "./themes/modern";

describe("starterTheme", () => {
  it("creates a complete editable copy of Modern Dark", () => {
    const theme = starterTheme();
    const variant = theme.variants.dark;

    expect(variant).toBeDefined();
    expect(Object.keys(variant?.colors ?? {}).sort()).toEqual(
      [...THEME_COLOR_KEYS].sort(),
    );
    expect(Object.keys(variant?.terminal ?? {}).sort()).toEqual(
      [...TERMINAL_BASE_KEYS, "ansi"].sort(),
    );
    expect(variant?.colors).toEqual(darkModernVariant.colors);
    expect(variant?.colors).not.toBe(darkModernVariant.colors);
    expect(variant?.terminal?.ansi).toEqual(darkModernVariant.terminal.ansi);
    expect(variant?.terminal?.ansi).not.toBe(darkModernVariant.terminal.ansi);
  });
});
