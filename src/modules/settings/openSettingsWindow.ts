/**
 * 本文件封装独立设置窗口的打开入口和有效分区标识。
 * 调用方只传递目标分区，窗口创建与复用由 Tauri 后端负责。
 */

import { invoke } from "@tauri-apps/api/core";

export type SettingsTab =
  | "general"
  | "editor"
  | "themes"
  | "shortcuts"
  | "models"
  | "agents"
  | "alpha"
  | "remote"
  | "about";

export async function openSettingsWindow(tab?: SettingsTab): Promise<void> {
  await invoke("open_settings_window", { tab: tab ?? null });
}
