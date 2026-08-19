/**
 * 本文件测试自定义主题起始模板的完整性。
 * 锁定新主题复制 Modern 明暗全部字段，且不会共享可变的颜色和 ANSI 容器。
 */

import { describe, expect, it } from "vitest";
import { TERMINAL_BASE_KEYS, THEME_COLOR_KEYS } from "./themeRegistry";
import { starterTheme } from "./themeFiles";
import { darkModernVariant, lightModernVariant } from "./themes/modern";

describe("starterTheme", () => {
  it.each([
    ["light", lightModernVariant],
    ["dark", darkModernVariant],
  ] as const)("creates a complete editable copy of Modern %s", (mode, baseline) => {
    const theme = starterTheme();
    const variant = theme.variants[mode];

    expect(variant).toBeDefined();
    expect(Object.keys(variant?.colors ?? {}).sort()).toEqual(
      [...THEME_COLOR_KEYS].sort(),
    );
    expect(Object.keys(variant?.terminal ?? {}).sort()).toEqual(
      [...TERMINAL_BASE_KEYS, "ansi"].sort(),
    );
    expect(variant?.colors).toEqual(baseline.colors);
    expect(variant?.colors).not.toBe(baseline.colors);
    expect(variant?.terminal?.ansi).toEqual(baseline.terminal.ansi);
    expect(variant?.terminal?.ansi).not.toBe(baseline.terminal.ansi);
  });
});
