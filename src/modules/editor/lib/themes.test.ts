/**
 * 本文件测试显式编辑器预设的按需构建与缓存。
 * 锁定 Modern 明暗模式独立，并避免重复创建内置 CodeMirror 扩展。
 */

import { describe, expect, it } from "vitest";
import { getEditorThemePreset } from "./themes";

describe("getEditorThemePreset", () => {
  it("caches embedded presets", () => {
    expect(getEditorThemePreset("kanagawa", "dark")).toBe(
      getEditorThemePreset("kanagawa", "dark"),
    );
  });

  it("keeps Modern light and dark extensions separate", () => {
    expect(getEditorThemePreset("modern", "light")).not.toBe(
      getEditorThemePreset("modern", "dark"),
    );
  });
});
