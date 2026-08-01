/**
 * 本文件解析当前 Space 及新 Workspace 的初始目录。
 * 只有 Local 显式启动目录会直接打开，普通新环境保持零标签空态。
 */

import type { WorkspaceEnv } from "@/modules/workspace";
import type { SpaceMeta } from "./store";

/** 从持久化 Space 列表中解析当前项，不存在时回退到首项。 */
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

/** 仅为带显式启动目录的 Local Workspace 返回初始根目录。 */
export function initialWorkspaceRoot(
  env: WorkspaceEnv,
  explicitLaunchDir: string | null,
): string | null {
  if (env.kind === "local" && explicitLaunchDir) return explicitLaunchDir;
  return null;
}
