/**
 * 本文件定义应用进程绑定的 Workspace 环境及其前端状态。
 * 环境在进程启动后不可切换，系统能力统一通过 Tauri command 访问。
 */

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export type WorkspaceEnv =
  | { kind: "local" }
  | { kind: "wsl"; distro: string }
  | { kind: "ssh"; profileId: string };

export type WslDistro = {
  name: string;
  default: boolean;
  running: boolean;
};

type State = {
  env: WorkspaceEnv;
  distros: WslDistro[];
  loading: boolean;
  error: string | null;
  setEnv: (env: WorkspaceEnv) => void;
  refreshDistros: () => Promise<WslDistro[]>;
};

export const LOCAL_WORKSPACE: WorkspaceEnv = { kind: "local" };
let defaultWorkspaceRootTask: Promise<string> | null = null;

export const useWorkspaceEnvStore = create<State>((set) => ({
  env: LOCAL_WORKSPACE,
  distros: [],
  loading: false,
  error: null,
  setEnv: (env) => set({ env }),
  refreshDistros: async () => {
    set({ loading: true, error: null });
    try {
      const distros = await invoke<WslDistro[]>("wsl_list_distros");
      set({ distros, loading: false });
      return distros;
    } catch (e) {
      set({ distros: [], loading: false, error: String(e) });
      return [];
    }
  },
}));

export function currentWorkspaceEnv(): WorkspaceEnv {
  return useWorkspaceEnvStore.getState().env;
}

export function workspaceScopeKey(env: WorkspaceEnv): string {
  if (env.kind === "wsl") return `wsl:${env.distro}`;
  if (env.kind === "ssh") return `ssh:${env.profileId}`;
  return "local";
}

export function parseWorkspaceScopeKey(key: string): WorkspaceEnv {
  if (key.startsWith("wsl:")) {
    return { kind: "wsl", distro: key.slice("wsl:".length) };
  }
  if (key.startsWith("ssh:")) {
    return { kind: "ssh", profileId: key.slice("ssh:".length) };
  }
  return LOCAL_WORKSPACE;
}

export function currentWorkspaceScopeKey(): string {
  return workspaceScopeKey(currentWorkspaceEnv());
}

export async function getWslHome(distro: string): Promise<string> {
  return invoke<string>("wsl_home", { distro });
}

/** 延迟准备当前进程环境的默认 Agent 工作目录，并合并严格模式下的重复请求。 */
export function prepareDefaultWorkspaceRoot(): Promise<string> {
  if (defaultWorkspaceRootTask) return defaultWorkspaceRootTask;
  const task = invoke<string>("workspace_prepare_default_root").catch(
    (error) => {
      if (defaultWorkspaceRootTask === task) defaultWorkspaceRootTask = null;
      throw error;
    },
  );
  defaultWorkspaceRootTask = task;
  return task;
}
