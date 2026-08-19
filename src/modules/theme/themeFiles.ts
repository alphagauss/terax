/**
 * 本文件管理自定义主题文件的创建、校验、读写与编辑事件。
 * 新主题以完整 Modern Dark 变体为起点，避免遗漏新增的主题语义字段。
 */

import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { appConfigDir, join } from "@tauri-apps/api/path";
import type { Theme } from "./types";
import { validateTheme, type ValidationResult } from "./validateTheme";
import { darkModernVariant } from "./themes/modern";

const THEME_FILE_EXT = ".terax-theme";
const THEME_EDIT_EVENT = "terax://theme-edit";

export type ThemeEditRequest =
  | { action: "create" }
  | { action: "edit"; id: string };

/** 判断路径是否指向 Terax 自定义主题文件。 */
export function isThemeFilePath(path: string): boolean {
  return path.toLowerCase().endsWith(THEME_FILE_EXT);
}

async function themesDir(): Promise<string> {
  return join(await appConfigDir(), "themes");
}

/** 返回指定自定义主题的配置文件路径。 */
export async function themeFilePath(id: string): Promise<string> {
  return join(await themesDir(), `${id}${THEME_FILE_EXT}`);
}

/** 将已校验主题写入应用主题目录并返回最终路径。 */
export async function writeThemeFile(theme: Theme): Promise<string> {
  const dir = await themesDir();
  const ws = currentWorkspaceEnv();
  const dirExists = await invoke("fs_stat", { path: dir, workspace: ws })
    .then(() => true)
    .catch(() => false);
  if (!dirExists) {
    await invoke("fs_create_dir", { path: dir, workspace: ws });
  }
  const path = await join(dir, `${theme.id}${THEME_FILE_EXT}`);
  await invoke("fs_write_file", {
    path,
    content: JSON.stringify(theme, null, 2),
    workspace: ws,
    source: "theme",
  });
  return path;
}

/** 删除指定自定义主题，文件不存在时保持幂等。 */
export async function deleteThemeFile(id: string): Promise<void> {
  try {
    const path = await themeFilePath(id);
    await invoke("fs_delete", { path, workspace: currentWorkspaceEnv() });
  } catch {
    /* 文件可能尚未创建，此时无需清理。 */
  }
}

/** 解析并校验自定义主题文件正文。 */
export function parseThemeFile(text: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "invalid JSON",
    };
  }
  return validateTheme(parsed);
}

/** 创建字段完整、可直接编辑的 Modern Dark 自定义主题模板。 */
export function starterTheme(): Theme {
  const id = `my-theme-${crypto.randomUUID().slice(0, 8)}`;
  return {
    id,
    name: "My Theme",
    description: "Custom theme based on the complete Modern Dark template.",
    editorTheme: { dark: "modern" },
    variants: {
      dark: {
        colors: { ...darkModernVariant.colors },
        terminal: {
          ...darkModernVariant.terminal,
          ansi: [...darkModernVariant.terminal.ansi],
        },
      },
    },
  };
}

/** 广播主题创建或编辑请求。 */
export function emitThemeEdit(req: ThemeEditRequest): Promise<void> {
  return emit(THEME_EDIT_EVENT, req);
}

/** 订阅主题编辑请求并返回解除订阅函数。 */
export function onThemeEdit(
  cb: (req: ThemeEditRequest) => void,
): Promise<UnlistenFn> {
  return listen<ThemeEditRequest>(THEME_EDIT_EVENT, (e) => cb(e.payload));
}
