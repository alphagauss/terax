import { readSearchTokens, readTerminalTokens } from "@/styles/tokens";
import type { ISearchDecorationOptions } from "@xterm/addon-search";
import type { ITheme } from "@xterm/xterm";

export function buildTerminalTheme(): ITheme {
  const t = readTerminalTokens();
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selection,
    black: t.ansiBlack,
    red: t.ansiRed,
    green: t.ansiGreen,
    yellow: t.ansiYellow,
    blue: t.ansiBlue,
    magenta: t.ansiMagenta,
    cyan: t.ansiCyan,
    white: t.ansiWhite,
    brightBlack: t.ansiBrightBlack,
    brightRed: t.ansiBrightRed,
    brightGreen: t.ansiBrightGreen,
    brightYellow: t.ansiBrightYellow,
    brightBlue: t.ansiBrightBlue,
    brightMagenta: t.ansiBrightMagenta,
    brightCyan: t.ansiBrightCyan,
    brightWhite: t.ansiBrightWhite,
  };
}

/** 让终端查找的正文装饰和滚动概览复用共享搜索配色。 */
export function buildTerminalSearchDecorations(): ISearchDecorationOptions {
  const colors = readSearchTokens();
  return {
    matchBackground: colors.matchBackground,
    activeMatchBackground: colors.currentMatchBackground,
    matchOverviewRuler: colors.matchBackground,
    activeMatchColorOverviewRuler: colors.currentMatchBackground,
  };
}
