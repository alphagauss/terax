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
  resolvedHome: string | null,
): string | null {
  if (env.kind === "local" && explicitLaunchDir) return explicitLaunchDir;
  return resolvedHome;
}

export function canBootWorkspaceEnvironment(
  env: WorkspaceEnv,
  resolvedHome: string | null,
): boolean {
  return env.kind === "local" || resolvedHome !== null;
}
