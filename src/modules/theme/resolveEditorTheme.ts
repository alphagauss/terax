/**
 * 本文件解析编辑器最终使用的内嵌调色板或用户显式预设。
 * 自动模式只读取当前应用主题文件，不维护额外的主题 ID 配对表。
 */

import {
  EDITOR_THEME_AUTO,
  type EditorThemeId,
  type EditorThemePref,
} from "@/modules/settings/store";
import { getBuiltinTheme, getDefaultTheme } from "./themes";
import type { EditorPalette, Theme, ThemeMode } from "./types";

export type ResolvedEditorTheme =
  | { kind: "inline"; mode: ThemeMode; palette: EditorPalette }
  | { kind: "preset"; id: EditorThemeId };

/** 解析应用主题，优先使用同 ID 的自定义主题。 */
function resolveAppTheme(themeId: string, customThemes: Theme[]): Theme {
  return (
    customThemes.find((theme) => theme.id === themeId) ??
    getBuiltinTheme(themeId) ??
    getDefaultTheme()
  );
}

/** 选择请求模式，单模式主题则明确返回其实际变体模式。 */
function selectEditorVariant(
  theme: Theme,
  mode: ThemeMode,
): { mode: ThemeMode; palette: EditorPalette } {
  const matching = theme.variants[mode];
  if (matching) return { mode, palette: matching.editor };
  if (theme.variants.dark) {
    return { mode: "dark", palette: theme.variants.dark.editor };
  }
  const light = theme.variants.light;
  if (!light) {
    throw new Error(`Theme ${theme.id} has no editor variant`);
  }
  return { mode: "light", palette: light.editor };
}

/** 解析编辑器主题，显式预设优先于应用主题内嵌调色板。 */
export function resolveEditorTheme(
  pref: EditorThemePref,
  themeId: string,
  customThemes: Theme[],
  mode: ThemeMode,
): ResolvedEditorTheme {
  if (pref !== EDITOR_THEME_AUTO) return { kind: "preset", id: pref };
  const selected = selectEditorVariant(
    resolveAppTheme(themeId, customThemes),
    mode,
  );
  return { kind: "inline", ...selected };
}
