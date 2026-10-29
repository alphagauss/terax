/**
 * 本文件测试主题 CSS 变量的应用。
 * 重点锁定局部主题继承 Modern 基准，并允许覆盖交互状态和 Git 标记语义色。
 */

// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, clearTheme } from "./applyTheme";
import { darkModernVariant, lightModernVariant } from "./themes/modern";
import type { Theme } from "./types";

afterEach(() => {
  clearTheme();
});

describe("applyTheme", () => {
  it("shares search colors across custom overrides, mode changes, and omitted fields", () => {
    const customized: Theme = {
      id: "search-customized",
      name: "Search Customized",
      variants: {
        dark: {
          editor: darkModernVariant.editor,
          colors: {
            searchMatchBackground: "#123456",
            searchCurrentMatchBackground: "#654321",
          },
        },
      },
    };
    const fallback: Theme = {
      id: "search-fallback",
      name: "Search Fallback",
      variants: { dark: { editor: darkModernVariant.editor } },
    };
    const style = document.documentElement.style;

    applyTheme(customized, "dark");
    expect(style.getPropertyValue("--search-match-background")).toBe("#123456");
    expect(style.getPropertyValue("--search-current-match-background")).toBe(
      "#654321",
    );

    for (const [mode, variant] of [
      ["dark", darkModernVariant],
      ["light", lightModernVariant],
    ] as const) {
      applyTheme(fallback, mode);
      expect(style.getPropertyValue("--search-match-background")).toBe(
        variant.colors.searchMatchBackground,
      );
      expect(style.getPropertyValue("--search-current-match-background")).toBe(
        variant.colors.searchCurrentMatchBackground,
      );
    }
    clearTheme();
    expect(style.getPropertyValue("--search-match-background")).toBe("");
    expect(style.getPropertyValue("--search-current-match-background")).toBe(
      "",
    );
  });

  it("applies optional interaction and divider colors and resets omissions to Modern", () => {
    const customized: Theme = {
      id: "interaction-customized",
      name: "Interaction Customized",
      variants: {
        dark: {
          editor: darkModernVariant.editor,
          colors: {
            interactiveHover: "custom-hover",
            interactiveActive: "custom-active",
            activityBarSelected: "custom-selected",
            layoutDivider: "#abcdef",
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
    expect(
      document.documentElement.style.getPropertyValue(
        "--activity-bar-selected",
      ),
    ).toBe("custom-selected");
    expect(
      document.documentElement.style.getPropertyValue("--layout-divider"),
    ).toBe("#abcdef");

    applyTheme(fallback, "dark");

    expect(
      document.documentElement.style.getPropertyValue("--interactive-hover"),
    ).toBe(darkModernVariant.colors.interactiveHover);
    expect(
      document.documentElement.style.getPropertyValue("--interactive-active"),
    ).toBe(darkModernVariant.colors.interactiveActive);
    expect(
      document.documentElement.style.getPropertyValue(
        "--activity-bar-selected",
      ),
    ).toBe(darkModernVariant.colors.activityBarSelected);
    expect(
      document.documentElement.style.getPropertyValue("--foreground"),
    ).toBe(darkModernVariant.colors.foreground);
    expect(
      document.documentElement.style.getPropertyValue("--layout-divider"),
    ).toBe(darkModernVariant.colors.layoutDivider);
    expect(
      document.documentElement.style.getPropertyValue("--terminal-ansi-yellow"),
    ).toBe(darkModernVariant.terminal.ansi[3]);

    applyTheme(fallback, "light");
    expect(
      document.documentElement.style.getPropertyValue(
        "--activity-bar-selected",
      ),
    ).toBe(lightModernVariant.colors.activityBarSelected);
    expect(
      document.documentElement.style.getPropertyValue("--layout-divider"),
    ).toBe(lightModernVariant.colors.layoutDivider);
    clearTheme();
    expect(
      document.documentElement.style.getPropertyValue(
        "--activity-bar-selected",
      ),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue("--layout-divider"),
    ).toBe("");
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
