/**
 * 本文件测试 Workspace Home 缓存的复用边界。
 * 重点锁定 SSH 路径缓存不能绕过断线后的重新连接。
 */

import { describe, expect, it } from "vitest";
import { canReuseWorkspaceHome } from "./useWorkspaceEnvironment";

describe("canReuseWorkspaceHome", () => {
  it("reuses Local and WSL homes without a connection status", () => {
    expect(canReuseWorkspaceHome({ kind: "local" }, "C:/Users/me")).toBe(true);
    expect(
      canReuseWorkspaceHome({ kind: "wsl", distro: "Ubuntu" }, "/home/me"),
    ).toBe(true);
  });

  it("reuses an SSH home only while the connection is live", () => {
    const env = { kind: "ssh", profileId: "server" } as const;
    expect(canReuseWorkspaceHome(env, "/home/me", "connected")).toBe(true);
    expect(canReuseWorkspaceHome(env, "/home/me", "connecting")).toBe(false);
    expect(canReuseWorkspaceHome(env, "/home/me", "disconnected")).toBe(false);
    expect(canReuseWorkspaceHome(env, "/home/me", "reconnecting")).toBe(false);
    expect(canReuseWorkspaceHome(env, "/home/me", "error")).toBe(false);
  });

  it("never reuses a missing home", () => {
    expect(canReuseWorkspaceHome({ kind: "local" }, null)).toBe(false);
    expect(
      canReuseWorkspaceHome(
        { kind: "ssh", profileId: "server" },
        null,
        "connected",
      ),
    ).toBe(false);
  });
});
