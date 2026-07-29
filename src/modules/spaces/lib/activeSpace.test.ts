/**
 * 本文件测试 Space 激活选择和新 Workspace 初始根目录。
 * 重点锁定只有显式 Local 启动目录会绕过基础空态。
 */

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
      initialWorkspaceRoot({ kind: "local" }, "C:/work", "C:/Users/me"),
    ).toBe("C:/work");
    expect(
      initialWorkspaceRoot(
        { kind: "wsl", distro: "Ubuntu" },
        "C:/work",
        "/home/aj",
      ),
    ).toBeNull();
  });

  it("keeps fresh Local, WSL, and SSH Workspaces empty", () => {
    expect(
      initialWorkspaceRoot({ kind: "local" }, null, "C:/Users/me"),
    ).toBeNull();
    expect(
      initialWorkspaceRoot({ kind: "wsl", distro: "Ubuntu" }, null, "/home/aj"),
    ).toBeNull();
    expect(
      initialWorkspaceRoot(
        { kind: "ssh", profileId: "server" },
        null,
        "/home/remote",
      ),
    ).toBeNull();
  });

  it("does not leak a host path when a remote home is unavailable", () => {
    expect(
      initialWorkspaceRoot({ kind: "wsl", distro: "Ubuntu" }, "C:/work", null),
    ).toBeNull();
  });
});

describe("canBootWorkspaceEnvironment", () => {
  it("keeps WSL and SSH terminals cold until their remote home resolves", () => {
    expect(
      canBootWorkspaceEnvironment({ kind: "wsl", distro: "Ubuntu" }, null),
    ).toBe(false);
    expect(
      canBootWorkspaceEnvironment({ kind: "ssh", profileId: "server" }, null),
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
