/**
 * 本文件解析命令面板的前缀模式。
 * 工作区内容搜索已迁移到独立侧边栏，这里只保留命令历史和帮助。
 */

import type { PaletteMode } from "../types";

export type ParsedQuery = {
  mode: PaletteMode;
  term: string;
  raw: string;
};

const PREFIXES: ReadonlyArray<{ sigil: string; mode: PaletteMode }> = [
  { sigil: ">", mode: "history" },
  { sigil: "?", mode: "help" },
];

export function parseQuery(raw: string): ParsedQuery {
  for (const { sigil, mode } of PREFIXES) {
    if (raw.startsWith(sigil)) {
      return { mode, term: raw.slice(sigil.length).trim(), raw };
    }
  }
  return { mode: "commands", term: raw.trim(), raw };
}
