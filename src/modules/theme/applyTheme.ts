/**
 * 本文件负责将主题配置写入根元素的 CSS 变量。
 * 切换主题时会清理上一主题的内联变量，并以完整 Modern 变体补齐缺失字段。
 */

import {
  TERMINAL_ANSI_VARIABLES,
  TERMINAL_BASE_KEYS,
  TERMINAL_BASE_VARIABLES,
  THEME_COLOR_VARIABLES,
} from "./themeRegistry";
import {
  darkModernVariant,
  lightModernVariant,
} from "./themes/modern";
import type {
  CompleteThemeVariant,
  Theme,
  ThemeColors,
  ThemeMode,
  ThemeVariant,
  TerminalPalette,
} from "./types";

const ALL_VARS: readonly string[] = [
  ...Object.values(THEME_COLOR_VARIABLES),
  ...Object.values(TERMINAL_BASE_VARIABLES),
  ...TERMINAL_ANSI_VARIABLES,
];

let lastApplied: string | null = null;

/** 按请求模式选择主题变体，单变体主题继续沿用其已有配色。 */
function selectVariant(theme: Theme, mode: ThemeMode): ThemeVariant | undefined {
  return theme.variants[mode] ?? theme.variants.dark ?? theme.variants.light;
}

/**
 * 将局部主题补全到 Modern 基准。
 *
 * 这样自定义主题和待整理的内置主题不会依赖全局 CSS 中散落的隐式颜色。
 */
function completeVariant(
  variant: ThemeVariant,
  mode: ThemeMode,
): CompleteThemeVariant {
  const baseline =
    mode === "dark" ? darkModernVariant : lightModernVariant;
  return {
    colors: { ...baseline.colors, ...variant.colors },
    terminal: {
      ...baseline.terminal,
      ...variant.terminal,
      ansi: variant.terminal?.ansi ?? baseline.terminal.ansi,
    },
  };
}

/** 应用指定模式的主题，并清理上一主题遗留的 CSS 变量。 */
export function applyTheme(theme: Theme, mode: ThemeMode): void {
  const root = document.documentElement;
  const variant = selectVariant(theme, mode);
  if (!variant) {
    clearTheme();
    return;
  }
  const completed = completeVariant(variant, mode);
  for (const v of ALL_VARS) root.style.removeProperty(v);
  writeColors(root, completed.colors);
  writeTerminal(root, completed.terminal);
  lastApplied = theme.id;
}

/** 清理主题写入的全部内联变量，恢复冷启动 CSS 安全回退。 */
export function clearTheme(): void {
  if (lastApplied === null) return;
  const root = document.documentElement;
  for (const v of ALL_VARS) root.style.removeProperty(v);
  lastApplied = null;
}

function writeColors(root: HTMLElement, c: ThemeColors): void {
  for (const k of Object.keys(c) as (keyof ThemeColors)[]) {
    const v = c[k];
    if (v) root.style.setProperty(THEME_COLOR_VARIABLES[k], v);
  }
}

function writeTerminal(root: HTMLElement, t: TerminalPalette): void {
  for (const k of TERMINAL_BASE_KEYS) {
    const value = t[k];
    if (value) root.style.setProperty(TERMINAL_BASE_VARIABLES[k], value);
  }
  if (t.ansi) {
    for (
      let i = 0;
      i < TERMINAL_ANSI_VARIABLES.length && i < t.ansi.length;
      i++
    ) {
      root.style.setProperty(TERMINAL_ANSI_VARIABLES[i], t.ansi[i]);
    }
  }
}
