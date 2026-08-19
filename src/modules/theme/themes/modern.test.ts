/**
 * 本文件测试 Modern 基准主题的字段完整性和关键语义色。
 * 锁定明暗变体可作为其他主题模板，并保持 VS Code Git decoration 配色。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TERMINAL_ANSI_VARIABLES,
  TERMINAL_BASE_KEYS,
  TERMINAL_BASE_VARIABLES,
  THEME_COLOR_KEYS,
  THEME_COLOR_VARIABLES,
} from "../themeRegistry";
import { darkModernVariant, lightModernVariant } from "./modern";

const here = path.dirname(fileURLToPath(import.meta.url));
const bootstrapCss = readFileSync(
  path.join(here, "../../../styles/workspace-bootstrap.css"),
  "utf8",
);
const globalsCss = readFileSync(
  path.join(here, "../../../styles/globals.css"),
  "utf8",
).toLowerCase();

describe("Modern reference template", () => {
  it.each([
    ["light", lightModernVariant],
    ["dark", darkModernVariant],
  ] as const)("declares every %s UI and terminal field", (_mode, variant) => {
    expect(Object.keys(variant.colors).sort()).toEqual(
      [...THEME_COLOR_KEYS].sort(),
    );
    expect(Object.keys(variant.terminal).sort()).toEqual(
      [...TERMINAL_BASE_KEYS, "ansi"].sort(),
    );
    expect(variant.terminal.ansi).toHaveLength(16);
  });

  it("keeps the pre-React window background aligned with Modern", () => {
    expect(bootstrapCss).toContain(
      `background-color: ${lightModernVariant.colors.background}`,
    );
    expect(bootstrapCss).toContain(
      `background-color: ${darkModernVariant.colors.background}`,
    );
  });

  it.each([
    ["light", lightModernVariant],
    ["dark", darkModernVariant],
  ] as const)("keeps the CSS safety fallback aligned with %s Modern", (_mode, variant) => {
    for (const key of THEME_COLOR_KEYS) {
      expect(globalsCss).toContain(
        `${THEME_COLOR_VARIABLES[key]}: ${variant.colors[key]}`.toLowerCase(),
      );
    }
    for (const key of TERMINAL_BASE_KEYS) {
      expect(globalsCss).toContain(
        `${TERMINAL_BASE_VARIABLES[key]}: ${variant.terminal[key]}`.toLowerCase(),
      );
    }
    for (let index = 0; index < TERMINAL_ANSI_VARIABLES.length; index++) {
      expect(globalsCss).toContain(
        `${TERMINAL_ANSI_VARIABLES[index]}: ${variant.terminal.ansi[index]}`.toLowerCase(),
      );
    }
  });
});

describe("Modern Git status colors", () => {
  it("uses the VS Code Light Modern colors", () => {
    expect(lightModernVariant.colors).toMatchObject({
      gitModified: "#895503",
      gitAdded: "#587C0C",
      gitUntracked: "#007100",
      gitRenamed: "#007100",
      gitDeleted: "#AD0707",
      editorGitModified: "#2472C8",
      editorGitAdded: "#0DBC79",
      editorGitDeleted: "#CD3131",
    });
  });

  it("uses the VS Code Dark Modern colors", () => {
    expect(darkModernVariant.colors).toMatchObject({
      gitModified: "#E2C08D",
      gitAdded: "#81B88B",
      gitUntracked: "#73C991",
      gitRenamed: "#73C991",
      gitDeleted: "#C74E39",
      editorGitModified: "#0451A5",
      editorGitAdded: "#107C10",
      editorGitDeleted: "#CD3131",
    });
  });
});
