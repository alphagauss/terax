/**
 * 本文件解析当前 Space 及新 Workspace 的初始目录。
 * 只有 Local 显式启动目录会直接打开，普通新环境保持零标签空态。
 */

import type { WorkspaceEnv } from "@/modules/workspace";
import type { SpaceMeta } from "./store";

export function findActiveSpace(
  spaces: SpaceMeta[],
  activeId: string | null,
): SpaceMeta | null {
  if (activeId) {
    const found = spaces.find((s) => s.id === activeId);
    if (found) return found;
  }
  return spaces[0] ?? null;
}

export function initialWorkspaceRoot(
  env: WorkspaceEnv,
  explicitLaunchDir: string | null,
  _resolvedHome: string | null,
): string | null {
  if (env.kind === "local" && explicitLaunchDir) return explicitLaunchDir;
  return null;
}

export function canBootWorkspaceEnvironment(
  env: WorkspaceEnv,
  resolvedHome: string | null,
): boolean {
  return env.kind === "local" || resolvedHome !== null;
}
