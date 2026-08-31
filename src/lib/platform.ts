/**
 * 本文件集中暴露宿主平台信息和跨平台快捷键显示约定。
 * 平台值在进程启动后保持不变；非 Tauri 测试环境统一标记为 unknown。
 */

import { platform } from "@tauri-apps/plugin-os";

const PLATFORM = (() => {
  try {
    return platform();
  } catch {
    return "";
  }
})();

export type HostPlatform = "macos" | "windows" | "linux" | "unknown";

export const HOST_PLATFORM: HostPlatform =
  PLATFORM === "macos" || PLATFORM === "windows" || PLATFORM === "linux"
    ? PLATFORM
    : "unknown";

export const IS_MAC = HOST_PLATFORM === "macos";
export const IS_LINUX = HOST_PLATFORM === "linux";
export const IS_WINDOWS = HOST_PLATFORM === "windows";

/** Custom window controls (min/max/close) are rendered by us only on
 * non-macOS platforms — macOS keeps the native traffic lights via the
 * overlay title bar. */
export const USE_CUSTOM_WINDOW_CONTROLS = !IS_MAC && PLATFORM !== "";

export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
/** KeyBinding property name for the platform's primary modifier. */
export const MOD_PROP: "meta" | "ctrl" = IS_MAC ? "meta" : "ctrl";
export const CTRL_KEY = IS_MAC ? "⌃" : "Ctrl";
export const ALT_KEY = IS_MAC ? "⌥" : "Alt";
export const SHIFT_KEY = IS_MAC ? "⇧" : "Shift";
export const TAB_KEY = IS_MAC ? "⇥" : "Tab";
export const ENTER_KEY = IS_MAC ? "↵" : "Enter";

export const KEY_SEP = IS_MAC ? "" : "+";

export function fmtShortcut(...parts: string[]): string {
  return parts.join(KEY_SEP);
}
