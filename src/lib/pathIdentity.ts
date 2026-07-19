import { IS_WINDOWS } from "@/lib/platform";
import { workspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace";
import { normalizePathForIdentity } from "./utils";

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

export function documentResourceKey(
  workspace: WorkspaceEnv,
  path: string,
  hostWindows = IS_WINDOWS,
): string {
  return `${workspaceScopeKey(workspace)}\u0000${documentPathIdentity(workspace, path, hostWindows)}`;
}
