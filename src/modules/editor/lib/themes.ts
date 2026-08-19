/**
 * 本文件登记用户可显式选择的 CodeMirror 主题扩展。
 * 内置应用主题的编辑器预设直接从对应主题文件构建，外部独立预设保持原包实现。
 */

import type { EditorThemeId } from "@/modules/settings/store";
import { catppuccin } from "@/modules/theme/themes/catppuccin";
import { dracula as draculaTheme } from "@/modules/theme/themes/dracula";
import { everforest } from "@/modules/theme/themes/everforest";
import { gruvbox } from "@/modules/theme/themes/gruvbox";
import { kanagawa as kanagawaTheme } from "@/modules/theme/themes/kanagawa";
import { kanagawaDragon as kanagawaDragonTheme } from "@/modules/theme/themes/kanagawa-dragon";
import { modern } from "@/modules/theme/themes/modern";
import { nord as nordTheme } from "@/modules/theme/themes/nord";
import { rosePine as rosePineTheme } from "@/modules/theme/themes/rose-pine";
import { solarized } from "@/modules/theme/themes/solarized";
import { tokyoNight as tokyoNightTheme } from "@/modules/theme/themes/tokyo-night";
import type { Theme, ThemeMode } from "@/modules/theme/types";
import type { Extension } from "@codemirror/state";
import { atomone } from "@uiw/codemirror-theme-atomone";
import { aura } from "@uiw/codemirror-theme-aura";
import { copilot } from "@uiw/codemirror-theme-copilot";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { xcodeDark, xcodeLight } from "@uiw/codemirror-theme-xcode";
import { createEditorThemeExtension } from "./editorTheme";

/** 从应用主题文件构建指定模式的编辑器扩展。 */
function embedded(theme: Theme, mode: ThemeMode): Extension {
  const variant = theme.variants[mode];
  if (!variant) throw new Error(`Theme ${theme.id} has no ${mode} variant`);
  return createEditorThemeExtension(variant.editor, mode);
}

const EMBEDDED_THEME_FACTORIES: Partial<
  Record<EditorThemeId, () => Extension>
> = {
  kanagawa: () => embedded(kanagawaTheme, "dark"),
  "kanagawa-lotus": () => embedded(kanagawaTheme, "light"),
  "kanagawa-dragon": () => embedded(kanagawaDragonTheme, "dark"),
  "tokyo-night": () => embedded(tokyoNightTheme, "dark"),
  "catppuccin-mocha": () => embedded(catppuccin, "dark"),
  "catppuccin-latte": () => embedded(catppuccin, "light"),
  "rose-pine": () => embedded(rosePineTheme, "dark"),
  "rose-pine-dawn": () => embedded(rosePineTheme, "light"),
  everforest: () => embedded(everforest, "dark"),
  "everforest-light": () => embedded(everforest, "light"),
  dracula: () => embedded(draculaTheme, "dark"),
  "solarized-dark": () => embedded(solarized, "dark"),
  "solarized-light": () => embedded(solarized, "light"),
  nord: () => embedded(nordTheme, "dark"),
  "gruvbox-dark": () => embedded(gruvbox, "dark"),
};

const EXTERNAL_THEME_EXTENSIONS: Partial<Record<EditorThemeId, Extension>> = {
  atomone,
  aura,
  copilot,
  "github-dark": githubDark,
  "github-light": githubLight,
  "xcode-dark": xcodeDark,
  "xcode-light": xcodeLight,
};

const embeddedCache = new Map<string, Extension>();

/** 按需读取显式编辑器预设，内置主题扩展只构建一次。 */
export function getEditorThemePreset(
  id: EditorThemeId,
  mode: ThemeMode,
): Extension {
  const external = EXTERNAL_THEME_EXTENSIONS[id];
  if (external) return external;

  const key = id === "modern" ? `modern:${mode}` : id;
  const cached = embeddedCache.get(key);
  if (cached) return cached;

  const extension =
    id === "modern"
      ? embedded(modern, mode)
      : (EMBEDDED_THEME_FACTORIES[id]?.() ?? atomone);
  embeddedCache.set(key, extension);
  return extension;
}
