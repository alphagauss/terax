/**
 * 本文件统一管理当前 Workspace 的文件监听订阅与恢复校验信号。
 *
 * 原生事件只表示资源可能失效；正文、目录和 Git 状态仍由各领域读取权威数据。
 */

import {
  documentEventResourceKey,
  documentEventPath,
  documentResourceKey,
} from "@/lib/pathIdentity";
import type { WorkspaceEnv } from "@/modules/workspace";
import { useRemoteRuntimeStore } from "@/modules/remote";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type FileWrittenPayload = { path: string; source?: string };
type FsChangedPayload = { paths: string[] };
type Listener = () => void;

type WatchEntry = {
  path: string;
  workspace: WorkspaceEnv;
  owners: number;
  registered: boolean;
};

const fileListeners = new Map<string, Set<Listener>>();
const changeListeners = new Set<(paths: string[]) => void>();
const resumeListeners = new Set<Listener>();
const watches = new Map<string, WatchEntry>();

let watchQueue = Promise.resolve();
let eventsStarted = false;
let lifecycleStarted = false;
let watchesEnabled = true;

/** 返回文件的父目录，同时兼容边界输入中的两种分隔符。 */
export function parentDirectory(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index <= 0) return path.slice(0, index + 1) || path;
  if (index === 2 && path[1] === ":") return path.slice(0, 3);
  return path.slice(0, index);
}

function enqueueWatchUpdate(key: string): void {
  watchQueue = watchQueue.then(async () => {
    const entry = watches.get(key);
    if (!entry) return;
    if (watchesEnabled && entry.owners > 0 && !entry.registered) {
      try {
        await invoke("fs_watch_add", {
          paths: [entry.path],
          workspace: entry.workspace,
        });
        entry.registered = true;
      } catch (error) {
        console.warn("[filesystem] watch add failed", entry.path, error);
      }
      return;
    }
    if ((!watchesEnabled || entry.owners === 0) && entry.registered) {
      try {
        await invoke("fs_watch_remove", {
          paths: [entry.path],
          workspace: entry.workspace,
        });
      } catch (error) {
        console.warn("[filesystem] watch remove failed", entry.path, error);
      }
      entry.registered = false;
    }
    if (entry.owners === 0 && !entry.registered) watches.delete(key);
  });
}

/** 在订阅存续期间监听一个目录；SSH 由领域轮询，不注册本地 watcher。 */
export function retainDirectoryWatch(
  workspace: WorkspaceEnv,
  path: string,
): () => void {
  if (workspace.kind === "ssh") return () => {};
  ensureEvents(workspace);
  ensureLifecycle();
  const key = documentResourceKey(workspace, path);
  const existing = watches.get(key);
  if (existing) existing.owners += 1;
  else
    watches.set(key, {
      path,
      workspace,
      owners: 1,
      registered: false,
    });
  enqueueWatchUpdate(key);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = watches.get(key);
    if (!entry) return;
    entry.owners = Math.max(0, entry.owners - 1);
    enqueueWatchUpdate(key);
  };
}

function emitFile(workspace: WorkspaceEnv, path: string): void {
  const listeners = fileListeners.get(
    documentEventResourceKey(workspace, path),
  );
  if (!listeners) return;
  for (const listener of listeners) listener();
}

function ensureEvents(workspace: WorkspaceEnv): void {
  if (eventsStarted) return;
  eventsStarted = true;
  const windowHandle = getCurrentWebviewWindow();
  const changed = windowHandle
    .listen<FsChangedPayload>("fs:changed", (event) => {
      for (const path of event.payload.paths) emitFile(workspace, path);
      const paths = event.payload.paths.map((path) =>
        documentEventPath(workspace, path),
      );
      for (const listener of changeListeners) listener(paths);
    })
    .catch((error) =>
      console.warn("[filesystem] event listener failed", error),
    );
  const written = windowHandle
    .listen<FileWrittenPayload>("fs:file-written", (event) => {
      if (event.payload.source !== "editor") {
        emitFile(workspace, event.payload.path);
      }
      for (const listener of changeListeners) {
        listener([documentEventPath(workspace, event.payload.path)]);
      }
    })
    .catch((error) =>
      console.warn("[filesystem] write listener failed", error),
    );
  // 先建立事件接收，再注册 watcher 和进行首次校验，避免启动间隙丢失变化。
  watchQueue = watchQueue.then(async () => {
    await Promise.all([changed, written]);
  });
}

function emitResume(): void {
  for (const listener of resumeListeners) listener();
}

function ensureLifecycle(): void {
  if (lifecycleStarted || typeof window === "undefined") return;
  lifecycleStarted = true;
  watchesEnabled = document.visibilityState !== "hidden";
  useRemoteRuntimeStore.subscribe((state, previous) => {
    const current = state.snapshot;
    if (
      current.phase === "connected" &&
      (previous.snapshot.phase !== "connected" ||
        current.epoch !== previous.snapshot.epoch) &&
      document.visibilityState !== "hidden"
    ) {
      emitResume();
    }
  });
  window.addEventListener("focus", () => {
    watchQueue = watchQueue.then(emitResume);
  });
  document.addEventListener("visibilitychange", () => {
    watchesEnabled = document.visibilityState !== "hidden";
    for (const key of watches.keys()) enqueueWatchUpdate(key);
    if (watchesEnabled) watchQueue = watchQueue.then(emitResume);
  });
}

/** 订阅一个前台文件，并在监听建立后校验一次磁盘版本。 */
export function subscribeActiveFile(
  workspace: WorkspaceEnv,
  path: string,
  listener: Listener,
): () => void {
  ensureEvents(workspace);
  ensureLifecycle();
  const key = documentResourceKey(workspace, path);
  const listeners = fileListeners.get(key) ?? new Set<Listener>();
  listeners.add(listener);
  fileListeners.set(key, listeners);
  const releaseWatch = retainDirectoryWatch(workspace, parentDirectory(path));
  let active = true;

  // watcher 命令已进入串行队列；随后校验可覆盖订阅前和注册过程中的变化。
  watchQueue = watchQueue.then(() => {
    if (active) listener();
  });

  return () => {
    active = false;
    listeners.delete(listener);
    if (listeners.size === 0) fileListeners.delete(key);
    releaseWatch();
  };
}

/** 订阅原始文件系统变更批次，供目录树按自身展示范围刷新。 */
export function subscribeFileSystemChanges(
  workspace: WorkspaceEnv,
  listener: (paths: string[]) => void,
): () => void {
  ensureEvents(workspace);
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** 当前窗口恢复交互时请求前台领域重新核对权威状态。 */
export function subscribeWorkspaceResume(listener: Listener): () => void {
  ensureLifecycle();
  resumeListeners.add(listener);
  return () => resumeListeners.delete(listener);
}
