import { invoke } from "@tauri-apps/api/core";

let cached: string | undefined;

export async function initLaunchDir(): Promise<void> {
  const dir =
    (await invoke<string | null>("get_launch_dir").catch(() => null)) ??
    (await invoke<string>("workspace_current_dir").catch(() => null));
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

export async function consumeLaunchFiles(): Promise<string[]> {
  const files = await invoke<string[]>("get_launch_files").catch(() => []);
  return files.map((file) => file.replace(/\\/g, "/"));
}

export async function consumeWorkspaceOpenFiles(): Promise<string[]> {
  const files = await invoke<string[]>("take_workspace_open_files").catch(
    () => [],
  );
  return files.map((file) => file.replace(/\\/g, "/"));
}
