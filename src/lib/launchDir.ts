/**
 * 本文件读取原生 Workspace 进程定向到当前窗口的待打开文件。
 * 目录启动上下文由 Workspace bootstrap 持有，不在前端重复缓存。
 */

import { invoke } from "@tauri-apps/api/core";

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
