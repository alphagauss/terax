import { describe, expect, it } from "vitest";
import {
  parseWorkspaceScopeKey,
  workspaceScopeKey,
  type WorkspaceEnv,
} from "./env";

describe("workspace scope keys", () => {
  it.each<WorkspaceEnv>([
    { kind: "local" },
    { kind: "wsl", distro: "Ubuntu-24.04" },
    { kind: "ssh", profileId: "production:primary" },
  ])("round-trips $kind workspaces", (workspace) => {
    expect(parseWorkspaceScopeKey(workspaceScopeKey(workspace))).toEqual(
      workspace,
    );
  });
});
