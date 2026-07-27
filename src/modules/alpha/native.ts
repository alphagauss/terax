/**
 * 本文件封装 Alpha 本机单例服务的 Tauri 命令。
 * 所有窗口通过同一组幂等接口查询和控制服务，不在前端复制生命周期状态。
 */

import { invoke } from "@tauri-apps/api/core";

export type AlphaStatus = {
  running: boolean;
  configured: boolean;
  pythonPath: string | null;
  autoStart: boolean;
  port: number;
  archiveHash: string;
  serviceArchiveHash: string | null;
  issue: "portConflict" | null;
};

export type PythonCheck = {
  path: string;
  version: string | null;
  missingPackages: string[];
  error: string | null;
};

/** 通过服务健康检查查询 Alpha 实时状态。 */
export function getAlphaStatus(): Promise<AlphaStatus> {
  return invoke("alpha_status");
}

/** 保存 Python 解释器并检查运行依赖。 */
export function setAlphaPythonPath(path: string): Promise<PythonCheck> {
  return invoke("alpha_set_python_path", { path });
}

/** 检查当前或显式指定的 Python 解释器。 */
export function checkAlphaPython(path?: string): Promise<PythonCheck> {
  return invoke("alpha_check_python", { path: path ?? null });
}

/** 更新共享的 Alpha 自动启动设置。 */
export function setAlphaAutoStart(enabled: boolean): Promise<void> {
  return invoke("alpha_set_auto_start", { enabled });
}

/** 幂等启动共享 Alpha 服务。 */
export function startAlpha(): Promise<AlphaStatus> {
  return invoke("alpha_start");
}

/** 幂等停止共享 Alpha 服务。 */
export function stopAlpha(): Promise<AlphaStatus> {
  return invoke("alpha_stop");
}

/** 重启共享 Alpha 服务。 */
export function restartAlpha(): Promise<AlphaStatus> {
  return invoke("alpha_restart");
}
