/**
 * 本文件管理当前 Workspace 进程的启动上下文与本地状态存储。
 *
 * 所有窗口级持久化都经过同一个 Tauri Store，关闭前可显式刷新到磁盘。
 */

import type { WorkspaceEnv } from "@/modules/workspace";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LazyStore } from "@tauri-apps/plugin-store";

export type WorkspaceBootstrap = {
  schemaVersion: 3;
  id: string;
  isPrimary: boolean;
  env: WorkspaceEnv;
  environmentKey: string;
  launchDir: string | null;
  launchFiles: string[];
  statePath: string;
  windowStateFilename: string;
  windowGeometry: WindowGeometry | null;
};

export type WindowGeometry = {
  width: number;
  height: number;
  x: number;
  y: number;
};

export type WorkspacePolicy = "fresh" | "recent";

let bootstrap: WorkspaceBootstrap | null = null;
let store: LazyStore | null = null;
const cache = new Map<string, unknown>();
const pendingWrites = new Set<Promise<unknown>>();

/** 跟踪尚未完成的 Store 修改，供关闭前刷新建立严格的写入顺序。 */
function trackWorkspaceWrite<T>(operation: Promise<T>): Promise<T> {
  pendingWrites.add(operation);
  const remove = () => pendingWrites.delete(operation);
  void operation.then(remove, remove);
  return operation;
}

export async function initializeWorkspaceProcess(): Promise<void> {
  bootstrap = await invoke<WorkspaceBootstrap>("get_workspace_bootstrap");
  store = new LazyStore(bootstrap.statePath, {
    defaults: {},
    autoSave: 200,
  });
  for (const [key, value] of await store.entries()) cache.set(key, value);
  useWorkspaceEnvStore.getState().setEnv(bootstrap.env);
}

export function currentWorkspaceBootstrap(): WorkspaceBootstrap {
  if (!bootstrap) throw new Error("Workspace bootstrap has not completed");
  return bootstrap;
}

export function getWorkspaceValue<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}

export function getWorkspaceEntries(): ReadonlyMap<string, unknown> {
  return cache;
}

export async function setWorkspaceValue(
  key: string,
  value: unknown,
): Promise<void> {
  if (!store) throw new Error("Workspace store has not initialized");
  cache.set(key, value);
  await trackWorkspaceWrite(store.set(key, value));
}

export async function deleteWorkspaceValue(key: string): Promise<void> {
  if (!store) throw new Error("Workspace store has not initialized");
  cache.delete(key);
  await trackWorkspaceWrite(store.delete(key));
}

/** 立即将当前 Workspace Store 的内存状态写入磁盘。 */
export async function flushWorkspaceStore(): Promise<void> {
  if (!store) throw new Error("Workspace store has not initialized");
  while (pendingWrites.size > 0) {
    await Promise.all(pendingWrites);
  }
  await store.save();
}

export async function spawnWorkspaceProcess(
  env: WorkspaceEnv,
  policy: WorkspacePolicy,
  launchDir?: string,
): Promise<number> {
  const windowGeometry = await nextWorkspaceWindowGeometry();
  return invoke<number>("spawn_workspace_process", {
    env,
    policy,
    launchDir: launchDir ?? null,
    windowGeometry,
  });
}

/** 计算新 Workspace 窗口相对当前窗口错开的初始几何信息。 */
export async function nextWorkspaceWindowGeometry(): Promise<WindowGeometry | null> {
  const window = getCurrentWindow();
  const [size, position, maximized] = await Promise.all([
    window.outerSize(),
    window.outerPosition(),
    window.isMaximized(),
  ]);
  return maximized
    ? null
    : {
        width: size.width,
        height: size.height,
        x: position.x + 32,
        y: position.y + 32,
      };
}

export function sameWorkspaceEnv(
  left: WorkspaceEnv,
  right: WorkspaceEnv,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "wsl" && right.kind === "wsl") {
    return left.distro === right.distro;
  }
  if (left.kind === "ssh" && right.kind === "ssh") {
    return left.profileId === right.profileId;
  }
  return left.kind === "local" && right.kind === "local";
}

export function policyForEnvironmentSelection(
  current: WorkspaceEnv,
  selected: WorkspaceEnv,
): WorkspacePolicy {
  return sameWorkspaceEnv(current, selected) ? "fresh" : "recent";
}
