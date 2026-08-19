/**
 * 本文件测试主题 CSS 变量的应用。
 * 重点锁定局部主题继承 Modern 基准，并允许覆盖交互状态和 Git 标记语义色。
 */

// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, clearTheme } from "./applyTheme";
import {
  darkModernVariant,
  lightModernVariant,
} from "./themes/modern";
import type { Theme } from "./types";

afterEach(() => {
  clearTheme();
});

describe("applyTheme", () => {
  it("applies optional interaction colors and resets omissions to Modern", () => {
    const customized: Theme = {
      id: "interaction-customized",
      name: "Interaction Customized",
      variants: {
        dark: {
          editor: darkModernVariant.editor,
          colors: {
            interactiveHover: "custom-hover",
            interactiveActive: "custom-active",
          },
        },
      },
    };
    const fallback: Theme = {
      id: "interaction-fallback",
      name: "Interaction Fallback",
      variants: { dark: { editor: darkModernVariant.editor } },
    };

    applyTheme(customized, "dark");

    expect(
      document.documentElement.style.getPropertyValue("--interactive-hover"),
    ).toBe("custom-hover");
    expect(
      document.documentElement.style.getPropertyValue("--interactive-active"),
    ).toBe("custom-active");

    applyTheme(fallback, "dark");

    expect(
      document.documentElement.style.getPropertyValue("--interactive-hover"),
    ).toBe(darkModernVariant.colors.interactiveHover);
    expect(
      document.documentElement.style.getPropertyValue("--interactive-active"),
    ).toBe(darkModernVariant.colors.interactiveActive);
    expect(
      document.documentElement.style.getPropertyValue("--foreground"),
    ).toBe(darkModernVariant.colors.foreground);
    expect(
      document.documentElement.style.getPropertyValue(
        "--terminal-ansi-yellow",
      ),
    ).toBe(darkModernVariant.terminal.ansi[3]);
  });

  it("uses the active mode semantic colors for editor Git markers", () => {
    const theme: Theme = {
      id: "editor-git",
      name: "Editor Git",
      variants: {
        dark: {
          editor: darkModernVariant.editor,
          colors: {
            editorGitDeleted: "dark-red",
            editorGitAdded: "dark-green",
            editorGitModified: "dark-blue",
          },
        },
        light: {
          editor: lightModernVariant.editor,
          colors: {
            editorGitDeleted: "light-red",
            editorGitAdded: "light-green",
            editorGitModified: "light-blue",
          },
        },
      },
    };

    applyTheme(theme, "dark");

    expect(
      document.documentElement.style.getPropertyValue("--editor-git-deleted"),
    ).toBe("dark-red");
    expect(
      document.documentElement.style.getPropertyValue("--editor-git-added"),
    ).toBe("dark-green");
    expect(
      document.documentElement.style.getPropertyValue("--editor-git-modified"),
    ).toBe("dark-blue");
  });
});
