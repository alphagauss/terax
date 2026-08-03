/**
 * 本文件为非活动标签对应的 Explorer 根目录执行低频预取。
 * 每个进程只保留一个串行读取循环，前台根目录由 FileExplorer 自身负责实时刷新。
 */

import { documentPathIdentity } from "@/lib/pathIdentity";
import {
  type DirectoryCacheInput,
  type DirEntry,
  writeCachedDirectory,
} from "@/modules/explorer/lib/directoryCache";
import { useRemoteRuntimeStore } from "@/modules/remote";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/workbench";
import { useWorkspaceEnvStore, type WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef } from "react";

export const BACKGROUND_DIRECTORY_REFRESH_MS = 5000;
const BACKGROUND_DIRECTORY_INITIAL_DELAY_MS = 1500;

/** 提取非活动标签显式关联的去重 Explorer 根目录。 */
export function collectBackgroundExplorerRoots(
  tabs: readonly Tab[],
  currentRoot: string | null,
  workspace: WorkspaceEnv,
): string[] {
  const currentIdentity = currentRoot
    ? documentPathIdentity(workspace, currentRoot)
    : null;
  const roots = new Map<string, string>();
  for (const tab of tabs) {
    const path =
      tab.kind === "terminal"
        ? tab.cwd
        : tab.kind === "editor" || tab.kind === "markdown"
          ? tab.explorerRoot
          : undefined;
    if (!path) continue;
    const identity = documentPathIdentity(workspace, path);
    if (identity === currentIdentity || roots.has(identity)) continue;
    roots.set(identity, path);
  }
  return [...roots.values()];
}

/** 按上次尝试位置选择下一个后台目录，失败目录不会阻塞后续候选。 */
export function pickNextExplorerRoot(
  roots: readonly string[],
  previousRoot: string | null,
): string | null {
  if (roots.length === 0) return null;
  const previousIndex =
    previousRoot === null ? -1 : roots.indexOf(previousRoot);
  return roots[(previousIndex + 1) % roots.length] ?? null;
}

type Params = {
  enabled: boolean;
  tabs: readonly Tab[];
  currentRoot: string | null;
};

/**
 * 串行低频刷新后台标签的根目录缓存。
 *
 * 目录成为前台后会从候选中移除，当前 FileExplorer 立即读取缓存并执行自己的刷新。
 */
export function useExplorerDirectoryPrefetch({
  enabled,
  tabs,
  currentRoot,
}: Params): void {
  const workspace = useWorkspaceEnvStore((state) => state.env);
  const runtime = useRemoteRuntimeStore((state) => state.snapshot);
  const showHidden = usePreferencesStore((state) => state.showHidden);
  const gitDecorations = usePreferencesStore(
    (state) => state.explorerGitDecorations,
  );
  const remoteEpoch =
    workspace.kind === "ssh" &&
    runtime.phase === "connected" &&
    runtime.profileId === workspace.profileId
      ? runtime.epoch
      : null;
  const remoteReady = workspace.kind !== "ssh" || remoteEpoch !== null;
  const roots = useMemo(
    () => collectBackgroundExplorerRoots(tabs, currentRoot, workspace),
    [currentRoot, tabs, workspace],
  );
  const refreshRunningRef = useRef(false);
  const lastAttemptedRootRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !remoteReady || roots.length === 0) return;
    let cancelled = false;
    let timer: number | null = null;

    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        timer = null;
        void refreshOne();
      }, delay);
    };
    const refreshOne = async () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        schedule(BACKGROUND_DIRECTORY_REFRESH_MS);
        return;
      }
      if (refreshRunningRef.current) {
        schedule(BACKGROUND_DIRECTORY_REFRESH_MS);
        return;
      }
      const cacheInput = (path: string): DirectoryCacheInput => ({
        workspace,
        path,
        showHidden,
        gitDecorations,
      });
      const root = pickNextExplorerRoot(roots, lastAttemptedRootRef.current);
      if (!root) return;
      lastAttemptedRootRef.current = root;
      refreshRunningRef.current = true;
      try {
        const entries = await invoke<DirEntry[]>("fs_read_dir", {
          path: root,
          showHidden,
          gitDecorations,
          workspace,
        });
        // SSH 重连后丢弃旧 Runtime 的迟到结果，避免用失效目录覆盖新缓存。
        const latestRuntime = useRemoteRuntimeStore.getState().snapshot;
        const remoteUnchanged =
          workspace.kind !== "ssh" ||
          (latestRuntime.phase === "connected" &&
            latestRuntime.profileId === workspace.profileId &&
            latestRuntime.epoch === remoteEpoch);
        if (!cancelled && remoteUnchanged) {
          writeCachedDirectory(cacheInput(root), { entries });
        }
      } catch {
        // 后台预取不改变前台错误状态；目录激活后由 FileExplorer 显示真实错误。
      } finally {
        refreshRunningRef.current = false;
        if (!cancelled) schedule(BACKGROUND_DIRECTORY_REFRESH_MS);
      }
    };

    schedule(BACKGROUND_DIRECTORY_INITIAL_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    enabled,
    gitDecorations,
    remoteEpoch,
    remoteReady,
    roots,
    showHidden,
    workspace,
  ]);
}
