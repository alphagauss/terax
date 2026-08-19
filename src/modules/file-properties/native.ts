/**
 * 本文件定义文件属性页与 Tauri 文件系统命令之间的只读协议。
 * 字段保留 POSIX 与 Windows 权限差异，目录汇总通过独立可取消请求加载。
 */

import { invoke } from "@tauri-apps/api/core";

export type PropertyKind = "file" | "directory" | "symlink";

export type AccessProperties =
  | {
      kind: "posix";
      mode: number;
      uid: number | null;
      gid: number | null;
      ownerName: string | null;
      groupName: string | null;
    }
  | {
      kind: "windows";
      readOnly: boolean;
      ownerName: string | null;
    }
  | { kind: "unavailable" };

export type FilePropertiesSnapshot = {
  path: string;
  name: string;
  kind: PropertyKind;
  logicalSizeBytes: number;
  allocatedSizeBytes: number | null;
  createdAt: number | null;
  modifiedAt: number | null;
  accessedAt: number | null;
  changedAt: number | null;
  access: AccessProperties;
};

export type DirectorySummary = {
  files: number;
  directories: number;
  symlinks: number;
  logicalSizeBytes: number;
  allocatedSizeBytes: number | null;
  unreadableEntries: number;
  complete: boolean;
};

/** 读取目标自身的快速属性快照。 */
export async function getFileProperties(
  path: string,
): Promise<FilePropertiesSnapshot> {
  return invoke<FilePropertiesSnapshot>("fs_properties_get", { path });
}

/** 递归统计目录内容，调用方负责为每次请求生成唯一 ID。 */
export async function scanDirectoryProperties(
  path: string,
  scanId: string,
): Promise<DirectorySummary> {
  return invoke<DirectorySummary>("fs_properties_scan", { path, scanId });
}

/** 取消仍在执行的目录统计。 */
export async function cancelDirectoryPropertiesScan(
  scanId: string,
): Promise<void> {
  await invoke("fs_properties_scan_cancel", { scanId });
}
