/**
 * 按文件与目录名称解析 Catppuccin 图标，并缓存同时包含明暗配色的 SVG。
 * SVG 根据宿主的 color-scheme 选择 Latte 或原始 Macchiato 配色。
 */

import catppuccinIcons from "@iconify-json/catppuccin/icons.json";
import { EXT_TO_LANGUAGE_ID } from "./constants";
import * as fileIconsMod from "./fileIcons";
import * as folderIconsMod from "./folderIcons";

const catFileNames = fileIconsMod.fileNames as Record<string, string>;
const catFileExtensions = fileIconsMod.fileExtensions as Record<string, string>;
const catLanguageIds = fileIconsMod.languageIds as Record<string, string>;
const catFolderNames = folderIconsMod.folderNames as Record<string, string>;

type IconifySet = {
  icons: Record<string, { body: string }>;
  aliases?: Record<string, { parent: string }>;
  width?: number;
  height?: number;
};

const cat = catppuccinIcons as unknown as IconifySet;
const CAT_W = cat.width ?? 16;
const CAT_H = cat.height ?? 16;

const DEFAULT_FILE = "file";
const DEFAULT_FOLDER = "folder";
const DEFAULT_FOLDER_OPEN = "folder-open";

// 将图标内使用的 Macchiato 颜色对应到官方 Latte 调色板。
const LATTE_COLORS: Record<string, string> = {
  "#f4dbd6": "#dc8a78",
  "#f0c6c6": "#dd7878",
  "#f5bde6": "#ea76cb",
  "#c6a0f6": "#8839ef",
  "#ed8796": "#d20f39",
  "#ee99a0": "#e64553",
  "#f5a97f": "#fe640b",
  "#eed49f": "#df8e1d",
  "#a6da95": "#40a02b",
  "#8bd5ca": "#179299",
  "#91d7e3": "#04a5e5",
  "#7dc4e4": "#209fb5",
  "#8aadf4": "#1e66f5",
  "#b7bdf8": "#7287fd",
  "#cad3f5": "#4c4f69",
  "#8087a2": "#8c8fa1",
};

const dataUrlCache = new Map<string, string>();

// Catppuccin's manifest emits names like `folder_src`/`typescript-react`, but
// the iconify export normalizes everything to hyphenated slugs.
function toIconifySlug(name: string): string {
  return name.replace(/_/g, "-");
}

function catBody(iconName: string): string | null {
  const slug = toIconifySlug(iconName);
  const direct = cat.icons[slug];
  if (direct) return direct.body;
  const alias = cat.aliases?.[slug];
  if (alias) {
    const parent = cat.icons[alias.parent];
    if (parent) return parent.body;
  }
  return null;
}

function buildDataUrl(iconName: string): string | null {
  const cached = dataUrlCache.get(iconName);
  if (cached !== undefined) return cached || null;
  const body = catBody(iconName);
  if (!body) {
    dataUrlCache.set(iconName, "");
    return null;
  }
  const lightRules = Object.entries(LATTE_COLORS)
    .filter(([color]) => body.includes(color))
    .map(
      ([color, latte]) =>
        `[fill="${color}"]{fill:${latte}}[stroke="${color}"]{stroke:${latte}}`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CAT_W} ${CAT_H}"><style>@media (prefers-color-scheme: light){${lightRules}}</style>${body}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  dataUrlCache.set(iconName, url);
  return url;
}

function extOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.indexOf(".");
  if (dot === -1 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

export function fileIconUrl(name: string): string {
  const lower = name.toLowerCase();

  const byName = catFileNames[lower];
  if (byName) {
    const url = buildDataUrl(byName);
    if (url) return url;
  }

  let ext = extOf(lower);
  while (ext) {
    const iconName = catFileExtensions[ext];
    if (iconName) {
      const url = buildDataUrl(iconName);
      if (url) return url;
    }
    const langId = EXT_TO_LANGUAGE_ID[ext];
    if (langId) {
      const iconByLang = catLanguageIds[langId];
      if (iconByLang) {
        const url = buildDataUrl(iconByLang);
        if (url) return url;
      }
    }
    const nextDot = ext.indexOf(".");
    if (nextDot === -1) break;
    ext = ext.slice(nextDot + 1);
  }

  return buildDataUrl(DEFAULT_FILE) ?? "";
}

export function folderIconUrl(name: string, expanded: boolean): string {
  const lower = name.toLowerCase();

  const mapped = catFolderNames[lower];
  if (mapped) {
    const slug = toIconifySlug(mapped);
    const target = expanded ? `${slug}-open` : slug;
    const url = buildDataUrl(target);
    if (url) return url;
  }

  return buildDataUrl(expanded ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER) ?? "";
}
