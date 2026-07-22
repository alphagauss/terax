/**
 * 本文件提供宿主机原生文件和目录选择入口。
 * 文件与文件夹分开选择以保持 macOS、Linux 和 Windows 的一致行为。
 */

import { open } from "@tauri-apps/plugin-dialog";

async function pickMany(options: {
  directory: boolean;
  multiple: boolean;
  title: string;
}): Promise<string[]> {
  const selected = await open(options);
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** 选择一个或多个宿主机文件。 */
export function pickUploadFiles(title: string): Promise<string[]> {
  return pickMany({ directory: false, multiple: true, title });
}

/** 选择一个或多个宿主机文件夹。 */
export function pickUploadFolders(title: string): Promise<string[]> {
  return pickMany({ directory: true, multiple: true, title });
}

/** 选择单个宿主机下载目标目录。 */
export async function pickDownloadDirectory(
  title: string,
): Promise<string | null> {
  const selected = await pickMany({
    directory: true,
    multiple: false,
    title,
  });
  return selected[0] ?? null;
}
