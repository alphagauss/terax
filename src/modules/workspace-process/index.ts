import type { WorkspaceEnv } from "@/modules/workspace";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";

export type WorkspaceBootstrap = {
  schemaVersion: 1;
  id: string;
  env: WorkspaceEnv;
  launchDir: string | null;
  statePath: string;
};

export type WorkspacePolicy = "fresh" | "recent";

let bootstrap: WorkspaceBootstrap | null = null;
let store: LazyStore | null = null;
const cache = new Map<string, unknown>();

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
  await store.set(key, value);
}

export async function deleteWorkspaceValue(key: string): Promise<void> {
  if (!store) throw new Error("Workspace store has not initialized");
  cache.delete(key);
  await store.delete(key);
}

export function spawnWorkspaceProcess(
  env: WorkspaceEnv,
  policy: WorkspacePolicy,
  launchDir?: string,
): Promise<number> {
  return invoke<number>("spawn_workspace_process", {
    env,
    policy,
    launchDir: launchDir ?? null,
  });
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
