/**
 * 本文件封装 Python 解释器发现与探测的 Tauri 命令。
 * 调用方决定选择结果的作用域，本模块不持久化解释器，也不修改任何 Python 环境。
 */

import type { WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";

export type PythonEnvironmentKind =
  | "workspaceVirtualEnv"
  | "virtualEnv"
  | "conda"
  | "system";

export type PythonInterpreterSource =
  | "workspace"
  | "activated"
  | "virtualEnv"
  | "conda"
  | "launcher"
  | "registry"
  | "path"
  | "manual";

export type PythonInterpreter = {
  path: string;
  environmentRoot: string;
  version: string;
  name: string;
  kind: PythonEnvironmentKind;
  source: PythonInterpreterSource;
};

/** 在指定 Workspace 环境和可选项目根目录中发现解释器。 */
export function listPythonInterpreters(
  root: string | null,
  workspace: WorkspaceEnv,
): Promise<PythonInterpreter[]> {
  return invoke("python_list_interpreters", { root, workspace });
}

/** 验证一个明确路径，并读取不依赖第三方包的解释器元数据。 */
export function probePythonInterpreter(
  path: string,
  workspace: WorkspaceEnv,
): Promise<PythonInterpreter> {
  return invoke("python_probe_interpreter", { path, workspace });
}
