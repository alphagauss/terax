/**
 * 本文件测试 Space 激活选择和新 Workspace 初始根目录。
 * 重点锁定只有显式 Local 启动目录会绕过基础空态。
 */

import { describe, expect, it } from "vitest";
import { findActiveSpace, initialWorkspaceRoot } from "./activeSpace";
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
    expect(initialWorkspaceRoot({ kind: "local" }, "C:/work")).toBe("C:/work");
    expect(
      initialWorkspaceRoot({ kind: "wsl", distro: "Ubuntu" }, "C:/work"),
    ).toBeNull();
  });

  it("keeps fresh Local, WSL, and SSH Workspaces empty", () => {
    expect(initialWorkspaceRoot({ kind: "local" }, null)).toBeNull();
    expect(
      initialWorkspaceRoot({ kind: "wsl", distro: "Ubuntu" }, null),
    ).toBeNull();
    expect(
      initialWorkspaceRoot({ kind: "ssh", profileId: "server" }, null),
    ).toBeNull();
  });

  it("does not leak a host path when a remote home is unavailable", () => {
    expect(
      initialWorkspaceRoot({ kind: "wsl", distro: "Ubuntu" }, "C:/work"),
    ).toBeNull();
  });
});
