import { describe, expect, it } from "vitest";
import {
  policyForEnvironmentSelection,
  sameWorkspaceEnv,
} from "./index";

describe("Workspace process model", () => {
  it("uses fresh when the current environment is selected again", () => {
    expect(
      policyForEnvironmentSelection(
        { kind: "wsl", distro: "Ubuntu" },
        { kind: "wsl", distro: "Ubuntu" },
      ),
    ).toBe("fresh");
  });

  it("uses recent for a different environment", () => {
    expect(
      policyForEnvironmentSelection(
        { kind: "local" },
        { kind: "ssh", profileId: "ssh-one" },
      ),
    ).toBe("recent");
  });

  it("compares environment-specific identity", () => {
    expect(
      sameWorkspaceEnv(
        { kind: "ssh", profileId: "one" },
        { kind: "ssh", profileId: "two" },
      ),
    ).toBe(false);
  });
});
