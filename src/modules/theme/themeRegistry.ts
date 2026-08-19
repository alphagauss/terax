/**
 * 本文件集中登记主题字段与运行时 CSS 变量的映射。
 * 主题应用、文件校验和终端读取必须复用本表，新增字段时不得在各模块重复维护清单。
 */

import type { TerminalPalette, ThemeColors } from "./types";

/** 应用 UI 主题字段对应的 CSS 变量。 */
export const THEME_COLOR_VARIABLES = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  cardForeground: "--card-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  destructive: "--destructive",
  success: "--success",
  warning: "--warning",
  info: "--info",
  border: "--border",
  input: "--input",
  ring: "--ring",
  interactiveHover: "--interactive-hover",
  interactiveActive: "--interactive-active",
  gitModified: "--git-modified",
  gitAdded: "--git-added",
  gitUntracked: "--git-untracked",
  gitRenamed: "--git-renamed",
  gitDeleted: "--git-deleted",
  editorGitModified: "--editor-git-modified",
  editorGitAdded: "--editor-git-added",
  editorGitDeleted: "--editor-git-deleted",
  chart1: "--chart-1",
  chart2: "--chart-2",
  chart3: "--chart-3",
  chart4: "--chart-4",
  chart5: "--chart-5",
  sidebar: "--sidebar",
  sidebarForeground: "--sidebar-foreground",
  sidebarPrimary: "--sidebar-primary",
  sidebarPrimaryForeground: "--sidebar-primary-foreground",
  sidebarAccent: "--sidebar-accent",
  sidebarAccentForeground: "--sidebar-accent-foreground",
  sidebarBorder: "--sidebar-border",
  sidebarRing: "--sidebar-ring",
  scrollbarThumb: "--scrollbar-thumb",
  scrollbarThumbHover: "--scrollbar-thumb-hover",
  scrollbarTrack: "--scrollbar-track",
  radius: "--radius",
} as const satisfies Record<keyof ThemeColors, string>;

/** 所有受支持的 UI 主题字段。 */
export const THEME_COLOR_KEYS = Object.freeze(
  Object.keys(THEME_COLOR_VARIABLES),
) as readonly (keyof ThemeColors)[];

/** 终端基础字段对应的 CSS 变量，ANSI 调色板按固定顺序单独登记。 */
export const TERMINAL_BASE_VARIABLES = {
  background: "--terminal-background",
  foreground: "--terminal-foreground",
  cursor: "--terminal-cursor",
  cursorAccent: "--terminal-cursor-accent",
  selection: "--terminal-selection",
} as const satisfies Record<Exclude<keyof TerminalPalette, "ansi">, string>;

/** ANSI 之外的全部终端主题字段。 */
export const TERMINAL_BASE_KEYS = Object.freeze(
  Object.keys(TERMINAL_BASE_VARIABLES),
) as readonly Exclude<keyof TerminalPalette, "ansi">[];

/** ANSI 普通色与亮色的固定 CSS 变量顺序。 */
export const TERMINAL_ANSI_VARIABLES = [
  "--terminal-ansi-black",
  "--terminal-ansi-red",
  "--terminal-ansi-green",
  "--terminal-ansi-yellow",
  "--terminal-ansi-blue",
  "--terminal-ansi-magenta",
  "--terminal-ansi-cyan",
  "--terminal-ansi-white",
  "--terminal-ansi-bright-black",
  "--terminal-ansi-bright-red",
  "--terminal-ansi-bright-green",
  "--terminal-ansi-bright-yellow",
  "--terminal-ansi-bright-blue",
  "--terminal-ansi-bright-magenta",
  "--terminal-ansi-bright-cyan",
  "--terminal-ansi-bright-white",
] as const;

/** 终端渲染器读取的完整 token 到 CSS 变量映射。 */
export const TERMINAL_TOKEN_VARIABLES = {
  ...TERMINAL_BASE_VARIABLES,
  ansiBlack: TERMINAL_ANSI_VARIABLES[0],
  ansiRed: TERMINAL_ANSI_VARIABLES[1],
  ansiGreen: TERMINAL_ANSI_VARIABLES[2],
  ansiYellow: TERMINAL_ANSI_VARIABLES[3],
  ansiBlue: TERMINAL_ANSI_VARIABLES[4],
  ansiMagenta: TERMINAL_ANSI_VARIABLES[5],
  ansiCyan: TERMINAL_ANSI_VARIABLES[6],
  ansiWhite: TERMINAL_ANSI_VARIABLES[7],
  ansiBrightBlack: TERMINAL_ANSI_VARIABLES[8],
  ansiBrightRed: TERMINAL_ANSI_VARIABLES[9],
  ansiBrightGreen: TERMINAL_ANSI_VARIABLES[10],
  ansiBrightYellow: TERMINAL_ANSI_VARIABLES[11],
  ansiBrightBlue: TERMINAL_ANSI_VARIABLES[12],
  ansiBrightMagenta: TERMINAL_ANSI_VARIABLES[13],
  ansiBrightCyan: TERMINAL_ANSI_VARIABLES[14],
  ansiBrightWhite: TERMINAL_ANSI_VARIABLES[15],
} as const;
