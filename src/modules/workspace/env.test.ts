/**
 * 本文件测试 Workspace 环境键与默认 Agent 工作目录的前端 IPC 边界。
 * 重点锁定环境标识往返和并发默认目录请求只触发一次原生命令。
 */

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  parseWorkspaceScopeKey,
  prepareDefaultWorkspaceRoot,
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

  it("coalesces concurrent default workspace preparation", async () => {
    mocks.invoke.mockResolvedValue("/home/alice/.terax/workspace");

    await expect(
      Promise.all([
        prepareDefaultWorkspaceRoot(),
        prepareDefaultWorkspaceRoot(),
      ]),
    ).resolves.toEqual([
      "/home/alice/.terax/workspace",
      "/home/alice/.terax/workspace",
    ]);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("workspace_prepare_default_root");
  });
});
