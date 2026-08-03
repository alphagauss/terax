/**
 * 本文件维护 Explorer 的进程内目录列表缓存。
 * 缓存按 Workspace、规范路径和显示选项隔离，只保存成功结果并使用有限 LRU 控制内存。
 */

import { documentResourceKey } from "@/lib/pathIdentity";
import type { WorkspaceEnv } from "@/modules/workspace";

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  gitignored: boolean;
};

export type DirectoryCacheInput = {
  workspace: WorkspaceEnv;
  path: string;
  showHidden: boolean;
  gitDecorations: boolean;
};

export type CachedDirectory = {
  entries: DirEntry[];
};

const DIRECTORY_CACHE_LIMIT = 128;
const directoryCache = new Map<string, CachedDirectory>();

function cacheKey(input: DirectoryCacheInput): string {
  return `${documentResourceKey(input.workspace, input.path)}\0hidden:${Number(
    input.showHidden,
  )}\0git:${Number(input.gitDecorations)}`;
}

/** 读取并提升一个目录缓存项的 LRU 顺序。 */
export function readCachedDirectory(
  input: DirectoryCacheInput,
): CachedDirectory | null {
  const key = cacheKey(input);
  const cached = directoryCache.get(key);
  if (!cached) return null;
  directoryCache.delete(key);
  directoryCache.set(key, cached);
  return cached;
}

/** 写入成功的目录读取结果，并淘汰最久未使用的缓存项。 */
export function writeCachedDirectory(
  input: DirectoryCacheInput,
  value: CachedDirectory,
): void {
  const key = cacheKey(input);
  directoryCache.delete(key);
  directoryCache.set(key, value);
  while (directoryCache.size > DIRECTORY_CACHE_LIMIT) {
    const oldest = directoryCache.keys().next().value;
    if (oldest === undefined) break;
    directoryCache.delete(oldest);
  }
}

/** 清空进程内目录缓存，仅供测试隔离使用。 */
export function resetDirectoryCacheForTests(): void {
  directoryCache.clear();
}
