/**
 * 本文件封装设置辅助窗口的业务入口和有效分区标识。
 * 调用方只传递目标分区，统一辅助窗口协议负责创建与复用。
 */

import { openAuxiliaryWindow } from "@/auxiliary/openAuxiliaryWindow";

export const SETTINGS_TABS = [
  "general",
  "editor",
  "themes",
  "shortcuts",
  "models",
  "agents",
  "remote",
  "about",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** 判断未知值是否是受支持的设置分区。 */
export function isSettingsTab(value: unknown): value is SettingsTab {
  return (
    typeof value === "string" &&
    (SETTINGS_TABS as readonly string[]).includes(value)
  );
}

/** 打开设置辅助窗口，并可指定首次或重新聚焦时显示的分区。 */
export async function openSettingsWindow(tab?: SettingsTab): Promise<void> {
  await openAuxiliaryWindow({
    kind: "settings",
    ...(tab ? { tab } : {}),
  });
}
