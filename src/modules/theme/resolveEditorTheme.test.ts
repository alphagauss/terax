/**
 * 本文件测试应用主题内嵌编辑器调色板和用户显式预设的解析顺序。
 * 锁定自动模式不依赖额外主题 ID 配对表。
 */

import { describe, expect, it } from "vitest";
import { resolveEditorTheme } from "./resolveEditorTheme";
import { getBuiltinTheme } from "./themes";
import { darkModernVariant, lightModernVariant } from "./themes/modern";
import type { Theme } from "./types";

const custom: Theme = {
  id: "my-theme",
  name: "Mine",
  variants: {
    dark: { editor: darkModernVariant.editor },
    light: { editor: lightModernVariant.editor },
  },
};

describe("resolveEditorTheme", () => {
  it("returns an explicit preset unchanged", () => {
    expect(resolveEditorTheme("nord", "kanagawa", [], "dark")).toEqual({
      kind: "preset",
      id: "nord",
    });
  });

  it("auto reads the matching builtin variant palette", () => {
    const theme = getBuiltinTheme("kanagawa");
    expect(resolveEditorTheme("auto", "kanagawa", [], "dark")).toEqual({
      kind: "inline",
      mode: "dark",
      palette: theme?.variants.dark?.editor,
    });
    expect(resolveEditorTheme("auto", "kanagawa", [], "light")).toEqual({
      kind: "inline",
      mode: "light",
      palette: theme?.variants.light?.editor,
    });
  });

  it("reports the actual mode when a single-mode theme is reused", () => {
    const theme = getBuiltinTheme("kanagawa-dragon");
    expect(resolveEditorTheme("auto", "kanagawa-dragon", [], "light")).toEqual({
      kind: "inline",
      mode: "dark",
      palette: theme?.variants.dark?.editor,
    });
  });

  it("prefers a matching custom theme over builtins", () => {
    expect(resolveEditorTheme("auto", "my-theme", [custom], "light")).toEqual({
      kind: "inline",
      mode: "light",
      palette: lightModernVariant.editor,
    });
  });

  it("uses Modern for an unknown app theme", () => {
    expect(resolveEditorTheme("auto", "does-not-exist", [], "dark")).toEqual({
      kind: "inline",
      mode: "dark",
      palette: darkModernVariant.editor,
    });
  });
});
