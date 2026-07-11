import { describe, expect, it } from "vitest";
import {
  canBootWorkspaceEnvironment,
  findActiveSpace,
  initialWorkspaceRoot,
} from "./activeSpace";
import type { SpaceMeta } from "./store";

function space(over: Partial<SpaceMeta>): SpaceMeta {
  return {
    id: "s1",
    name: "Space",
    root: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("findActiveSpace", () => {
  it("returns the space matching activeId", () => {
    const spaces = [space({ id: "a" }), space({ id: "b" })];
    expect(findActiveSpace(spaces, "b")?.id).toBe("b");
  });

  it("falls back to the first space when activeId is null or unknown", () => {
    const spaces = [space({ id: "a" }), space({ id: "b" })];
    expect(findActiveSpace(spaces, null)?.id).toBe("a");
    expect(findActiveSpace(spaces, "missing")?.id).toBe("a");
  });

  it("returns null when there are no spaces", () => {
    expect(findActiveSpace([], "a")).toBeNull();
  });
});

describe("initialWorkspaceRoot", () => {
  it("uses an explicit launch directory only for Local", () => {
    expect(
      initialWorkspaceRoot(
        { kind: "local" },
        "C:/work",
        "C:/Users/me",
      ),
    ).toBe("C:/work");
    expect(
      initialWorkspaceRoot(
        { kind: "wsl", distro: "Ubuntu" },
        "C:/work",
        "/home/aj",
      ),
    ).toBe("/home/aj");
  });

  it("uses the resolved environment home for fresh Local, WSL, and SSH", () => {
    expect(
      initialWorkspaceRoot({ kind: "local" }, null, "C:/Users/me"),
    ).toBe("C:/Users/me");
    expect(
      initialWorkspaceRoot(
        { kind: "wsl", distro: "Ubuntu" },
        null,
        "/home/aj",
      ),
    ).toBe("/home/aj");
    expect(
      initialWorkspaceRoot(
        { kind: "ssh", profileId: "server" },
        null,
        "/home/remote",
      ),
    ).toBe("/home/remote");
  });

  it("does not leak a host path when a remote home is unavailable", () => {
    expect(
      initialWorkspaceRoot(
        { kind: "wsl", distro: "Ubuntu" },
        "C:/work",
        null,
      ),
    ).toBeNull();
  });
});

describe("canBootWorkspaceEnvironment", () => {
  it("keeps WSL and SSH terminals cold until their remote home resolves", () => {
    expect(
      canBootWorkspaceEnvironment({ kind: "wsl", distro: "Ubuntu" }, null),
    ).toBe(false);
    expect(
      canBootWorkspaceEnvironment(
        { kind: "ssh", profileId: "server" },
        null,
      ),
    ).toBe(false);
    expect(
      canBootWorkspaceEnvironment(
        { kind: "ssh", profileId: "server" },
        "/home/remote",
      ),
    ).toBe(true);
  });

  it("allows Local to use the process default when home lookup fails", () => {
    expect(canBootWorkspaceEnvironment({ kind: "local" }, null)).toBe(true);
  });
});
