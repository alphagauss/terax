/**
 * 本文件测试自定义主题配置的结构校验。
 * 锁定可用颜色字段、变体要求和终端调色板边界。
 */

import { describe, expect, it } from "vitest";
import { validateTheme } from "./validateTheme";

function baseTheme(over: Record<string, unknown> = {}) {
  return {
    id: "ok-id",
    name: "Cool Theme",
    variants: { dark: { colors: { background: "#000" } } },
    ...over,
  };
}

describe("validateTheme", () => {
  it("rejects a non-object payload", () => {
    expect(validateTheme("nope")).toEqual({
      ok: false,
      error: "Theme must be a JSON object",
    });
  });

  it("rejects ids that are not kebab-case or too short", () => {
    expect(validateTheme(baseTheme({ id: "Foo" })).ok).toBe(false);
    expect(validateTheme(baseTheme({ id: "a" })).ok).toBe(false);
    expect(validateTheme(baseTheme({ id: "has space" })).ok).toBe(false);
  });

  it("requires a non-empty name and trims it", () => {
    expect(validateTheme(baseTheme({ name: "  " })).ok).toBe(false);
    const result = validateTheme(baseTheme({ name: "  Padded  " }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.theme.name).toBe("Padded");
  });

  it("requires a variants object with at least one of light or dark", () => {
    expect(validateTheme(baseTheme({ variants: undefined })).ok).toBe(false);
    expect(validateTheme(baseTheme({ variants: {} }))).toEqual({
      ok: false,
      error: "variants must contain at least one of: light, dark",
    });
  });

  it("accepts a minimal single-variant theme", () => {
    const result = validateTheme({
      id: "ok-id",
      name: "X",
      variants: { dark: {} },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unrecognized color keys", () => {
    const result = validateTheme(
      baseTheme({ variants: { dark: { colors: { nope: "#fff" } } } }),
    );
    expect(result).toEqual({
      ok: false,
      error: "variants.dark.colors.nope is not a recognized color key",
    });
  });

  it("rejects empty color values", () => {
    const result = validateTheme(
      baseTheme({ variants: { dark: { colors: { background: "" } } } }),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts Git status and editor marker semantic colors", () => {
    const result = validateTheme(
      baseTheme({
        variants: {
          dark: {
            colors: {
              gitModified: "#e2c08d",
              gitAdded: "#81b88b",
              gitUntracked: "#73c991",
              gitRenamed: "#73c991",
              gitDeleted: "#c74e39",
              editorGitModified: "#0451a5",
              editorGitAdded: "#107c10",
              editorGitDeleted: "#cd3131",
            },
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("requires the terminal ansi palette to have exactly 16 entries", () => {
    const result = validateTheme(
      baseTheme({ variants: { dark: { terminal: { ansi: ["#000"] } } } }),
    );
    expect(result).toEqual({
      ok: false,
      error: "variants.dark.terminal.ansi must be an array of 16 strings",
    });
  });

  it("captures optional author, description, and editor theme", () => {
    const result = validateTheme(
      baseTheme({
        author: "me",
        description: "a theme",
        editorTheme: { dark: "tokyo" },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.theme.author).toBe("me");
      expect(result.theme.description).toBe("a theme");
      expect(result.theme.editorTheme).toEqual({ dark: "tokyo" });
    }
  });
});
