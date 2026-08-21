/**
 * 本文件读取创建当前 Workspace 进程时携带的待打开文件。
 * 已运行窗口接收的文件改由运行时消息队列处理，不在此处重复消费。
 */

import { invoke } from "@tauri-apps/api/core";

/** 判断恢复流程是否已经允许消费仅可读取一次的启动文件。 */
export function canConsumeLaunchFiles(
  workbenchBooted: boolean,
  spacesHydrated: boolean,
): boolean {
  return workbenchBooted && spacesHydrated;
}

/** 读取并规范化当前 Workspace 进程尚未消费的启动文件。 */
export async function consumeLaunchFiles(): Promise<string[]> {
  const files = await invoke<string[]>("get_launch_files").catch(() => []);
  return files.map((file) => file.replace(/\\/g, "/"));
}
