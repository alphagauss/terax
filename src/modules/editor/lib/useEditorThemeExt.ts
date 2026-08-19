/**
 * 本文件根据应用主题与用户覆盖设置解析 CodeMirror 主题扩展。
 * 自动模式使用主题文件内嵌 editor 调色板，显式选择继续使用独立预设。
 */

import { usePreferencesStore } from "@/modules/settings/preferences";
import { resolveEditorTheme, useTheme } from "@/modules/theme";
import type { Extension } from "@codemirror/state";
import { useMemo } from "react";
import { createEditorThemeExtension } from "./editorTheme";
import { EDITOR_THEME_EXT, MODERN_EDITOR_THEME_EXT } from "./themes";

/** 解析当前 CodeMirror 主题扩展，并优先应用用户显式预设。 */
export function useEditorThemeExt(): Extension {
  const pref = usePreferencesStore((s) => s.editorTheme);
  const { themeId, customThemes, resolvedMode } = useTheme();
  return useMemo(() => {
    const resolved = resolveEditorTheme(
      pref,
      themeId,
      customThemes,
      resolvedMode,
    );
    if (resolved.kind === "inline") {
      return createEditorThemeExtension(resolved.palette, resolved.mode);
    }
    if (resolved.id === "modern") {
      return MODERN_EDITOR_THEME_EXT[resolvedMode];
    }
    return EDITOR_THEME_EXT[resolved.id] ?? EDITOR_THEME_EXT.atomone;
  }, [pref, themeId, customThemes, resolvedMode]);
}
