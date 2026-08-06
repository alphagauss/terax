/**
 * 本文件定义跨平台文档路径身份。
 *
 * 本地 Windows 路径忽略大小写，WSL 事件路径会从宿主机形式还原为发行版内路径。
 */

import { IS_WINDOWS } from "@/lib/platform";
import { type WorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";
import { normalizePathForIdentity } from "./utils";

/** 按工作区的路径语义生成稳定身份。 */
export function documentPathIdentity(
  workspace: WorkspaceEnv,
  path: string,
  hostWindows = IS_WINDOWS,
): string {
  return normalizePathForIdentity(
    path,
    workspace.kind === "local" && hostWindows,
  );
}

/** 将工作区范围与路径身份组合为共享文档键。 */
export function documentResourceKey(
  workspace: WorkspaceEnv,
  path: string,
  hostWindows = IS_WINDOWS,
): string {
  return `${workspaceScopeKey(workspace)}\u0000${documentPathIdentity(workspace, path, hostWindows)}`;
}

/** 将文件监听器返回的宿主机路径转换为工作区内的逻辑路径。 */
export function documentEventPath(
  workspace: WorkspaceEnv,
  path: string,
): string {
  const normalized = path.replace(/\\/g, "/");
  if (workspace.kind !== "wsl") return normalized;

  const unc = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i);
  if (unc?.[2]?.toLowerCase() === workspace.distro.toLowerCase()) {
    return unc[3] || "/";
  }
  const drive = normalized.match(/^([a-z]):(?:\/(.*))?$/i);
  if (drive?.[1]) {
    const suffix = drive[2] ? `/${drive[2]}` : "";
    return `/mnt/${drive[1].toLowerCase()}${suffix}`;
  }
  return normalized;
}

/** 生成文件事件路径对应的共享文档键。 */
export function documentEventResourceKey(
  workspace: WorkspaceEnv,
  path: string,
  hostWindows = IS_WINDOWS,
): string {
  return documentResourceKey(
    workspace,
    documentEventPath(workspace, path),
    hostWindows,
  );
}
