/**
 * 本文件测试主题 CSS 变量的应用。
 * 重点锁定编辑器 Git 标记使用当前主题模式显式声明的语义色。
 */

// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, clearTheme } from "./applyTheme";
import type { Theme } from "./types";

afterEach(() => {
  clearTheme();
});

describe("applyTheme", () => {
  it("uses the active mode semantic colors for editor Git markers", () => {
    const theme: Theme = {
      id: "editor-git",
      name: "Editor Git",
      variants: {
        dark: {
          colors: {
            editorGitDeleted: "dark-red",
            editorGitAdded: "dark-green",
            editorGitModified: "dark-blue",
          },
        },
        light: {
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
