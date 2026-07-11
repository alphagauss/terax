import {
  deleteSharedStoreKey,
  onSharedStoreChange,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { Theme } from "./types";

const themeKey = (id: string) => `theme:${id}`;

export async function listCustomThemes(): Promise<Theme[]> {
  const values = await readSharedStore("custom-themes");
  const records = Object.entries(values)
    .filter(([key]) => key.startsWith("theme:"))
    .map(([, value]) => value as Theme);
  return records;
}

export function saveCustomTheme(theme: Theme): Promise<void> {
  return setSharedStoreKey("custom-themes", themeKey(theme.id), theme);
}

export function deleteCustomTheme(id: string): Promise<void> {
  return deleteSharedStoreKey("custom-themes", themeKey(id));
}

export function onCustomThemesChange(cb: () => void): Promise<UnlistenFn> {
  return onSharedStoreChange("custom-themes", cb);
}
