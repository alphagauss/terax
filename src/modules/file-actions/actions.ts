/** 聊天引用与资源管理器共用的文件操作，始终使用当前进程的固定环境。 */
import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import type { FileReference } from "@/modules/file-actions/references";

export type FileTarget = { path: string; isDir: boolean; line?: number };
type Stat = { kind: string };

/** 查询链接实际指向的类型，但保留用户引用的路径用于打开和复制。 */
async function statTarget(
  path: string,
  workspace: WorkspaceEnv,
): Promise<Stat> {
  const stat = await invoke<Stat>("fs_stat", { path, workspace });
  if (stat.kind !== "symlink") return stat;
  const canonical = await invoke<string>("fs_canonicalize", {
    path,
    workspace,
  });
  return invoke<Stat>("fs_stat", { path: canonical, workspace });
}

export async function resolveFileReference(
  reference: FileReference,
): Promise<FileTarget> {
  const workspace = currentWorkspaceEnv();
  // POSIX 中冒号可属于文件名，优先查询完整路径。
  if (reference.line && !/^[a-z]:\//i.test(reference.path)) {
    try {
      const stat = await statTarget(reference.literalPath, workspace);
      return { path: reference.literalPath, isDir: stat.kind === "dir" };
    } catch {
      /* 完整路径不存在时再查询带行号引用的实际文件。 */
    }
  }
  const stat = await statTarget(reference.path, workspace);
  return {
    path: reference.path,
    isDir: stat.kind === "dir",
    line: stat.kind === "dir" ? undefined : reference.line,
  };
}

export const revealFile = (path: string) => revealItemInDir(path);
export const openSystemFile = (path: string) => openPath(path);
export const copyFilePath = (path: string) =>
  navigator.clipboard.writeText(path);

export async function copyFileContent(path: string): Promise<void> {
  const result = await invoke<
    { kind: "text"; content: string } | { kind: "binary" | "toolarge" }
  >("fs_read_file", { path, workspace: currentWorkspaceEnv(), force: false });
  if (result.kind !== "text")
    throw new Error(result.kind === "binary" ? "binary" : "toolarge");
  await navigator.clipboard.writeText(result.content);
}
