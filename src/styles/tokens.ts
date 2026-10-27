/**
 * 本文件读取当前主题已经解析的终端与搜索 CSS token。
 * 字段与变量映射由主题注册表统一提供，本模块只负责浏览器计算值读取。
 */

import {
  TERMINAL_TOKEN_VARIABLES,
  THEME_COLOR_VARIABLES,
} from "@/modules/theme/themeRegistry";

export type TerminalTokens = Record<
  keyof typeof TERMINAL_TOKEN_VARIABLES,
  string
>;

const KEYS = Object.keys(
  TERMINAL_TOKEN_VARIABLES,
) as (keyof TerminalTokens)[];

let probe: HTMLDivElement | null = null;

function getProbe(): HTMLDivElement {
  if (probe?.isConnected) return probe;
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none;contain:strict;width:0;height:0;";
  document.body.appendChild(el);
  probe = el;
  return el;
}

function resolve(el: HTMLDivElement, varName: string): string {
  el.style.color = `var(${varName})`;
  return getComputedStyle(el).color;
}

/** 读取当前文档中全部终端主题 token 的计算颜色。 */
export function readTerminalTokens(): TerminalTokens {
  const el = getProbe();
  const out = {} as TerminalTokens;
  for (const k of KEYS) {
    out[k] = resolve(el, TERMINAL_TOKEN_VARIABLES[k]);
  }
  return out;
}

/** 解析共享搜索色，让不支持 CSS 变量的终端装饰读取与正文相同的颜色。 */
export function readSearchTokens() {
  const el = getProbe();
  return {
    matchBackground: resolve(el, THEME_COLOR_VARIABLES.searchMatchBackground),
    currentMatchBackground: resolve(
      el,
      THEME_COLOR_VARIABLES.searchCurrentMatchBackground,
    ),
  };
}
