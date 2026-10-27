/**
 * 本文件测试自定义主题配置的结构校验。
 * 锁定 UI、终端、编辑器字段及严格的主题结构边界。
 */

import { describe, expect, it } from "vitest";
import { darkModernVariant } from "./themes/modern";
import { validateTheme } from "./validateTheme";

const editor = darkModernVariant.editor;

function baseTheme(over: Record<string, unknown> = {}) {
  return {
    id: "ok-id",
    name: "Cool Theme",
    variants: { dark: { colors: { background: "#000" }, editor } },
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

  it("accepts a single-variant theme with an embedded editor palette", () => {
    const result = validateTheme({
      id: "ok-id",
      name: "X",
      variants: { dark: { editor } },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unrecognized color keys", () => {
    const result = validateTheme(
      baseTheme({
        variants: { dark: { colors: { nope: "#fff" }, editor } },
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: "variants.dark.colors.nope is not a recognized color key",
    });
  });

  it("rejects empty color values", () => {
    const result = validateTheme(
      baseTheme({
        variants: { dark: { colors: { background: "" }, editor } },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts registered interaction, divider, Git, chart, and scrollbar colors", () => {
    const result = validateTheme(
      baseTheme({
        variants: {
          dark: {
            editor,
            colors: {
              interactiveHover: "rgba(255,255,255,0.09)",
              interactiveActive: "rgba(255,255,255,0.13)",
              searchMatchBackground: "#3c382b",
              searchCurrentMatchBackground: "#5b482e",
              layoutDivider: "#d7d7d7",
              success: "#73c991",
              warning: "#e2c08d",
              info: "#4daafc",
              gitModified: "#e2c08d",
              gitAdded: "#81b88b",
              gitUntracked: "#73c991",
              gitRenamed: "#73c991",
              gitDeleted: "#c74e39",
              editorGitModified: "#0451a5",
              editorGitAdded: "#107c10",
              editorGitDeleted: "#cd3131",
              chart1: "#111111",
              chart2: "#222222",
              chart3: "#333333",
              chart4: "#444444",
              chart5: "#555555",
              scrollbarThumb: "#666666",
              scrollbarThumbHover: "#777777",
              scrollbarTrack: "transparent",
            },
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("requires the terminal ansi palette to have exactly 16 entries", () => {
    const result = validateTheme(
      baseTheme({
        variants: { dark: { terminal: { ansi: ["#000"] }, editor } },
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: "variants.dark.terminal.ansi must be an array of 16 strings",
    });
  });

  it("rejects unregistered terminal fields", () => {
    const result = validateTheme(
      baseTheme({
        variants: { dark: { terminal: { nope: "#000" }, editor } },
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: "variants.dark.terminal.nope is not a recognized terminal key",
    });
  });

  it("requires every variant to embed a complete editor palette", () => {
    const missing = validateTheme({
      id: "no-editor",
      name: "No Editor",
      variants: { dark: {} },
    });
    expect(missing).toEqual({
      ok: false,
      error: "variants.dark.editor must be an object",
    });

    const incomplete = validateTheme({
      id: "bad-editor",
      name: "Bad Editor",
      variants: { dark: { editor: { background: "#000" } } },
    });
    expect(incomplete).toEqual({
      ok: false,
      error: "variants.dark.editor.foreground must be a non-empty string",
    });
  });

  it("rejects the removed top-level editorTheme reference", () => {
    expect(validateTheme(baseTheme({ editorTheme: { dark: "tokyo" } }))).toEqual(
      {
        ok: false,
        error: "editorTheme is not a recognized theme key",
      },
    );
  });

  it("captures optional author and description", () => {
    const result = validateTheme(
      baseTheme({
        author: "me",
        description: "a theme",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.theme.author).toBe("me");
      expect(result.theme.description).toBe("a theme");
    }
  });
});
