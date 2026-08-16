/**
 * 本文件验证 Workspace 进程环境选择、启动参数边界和冷启动显示顺序。
 * HTML 只提供轻量冷启动占位；窗口几何必须由原生命令从主窗口推导。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentWindow: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: mocks.getCurrentWindow,
}));

import {
  policyForEnvironmentSelection,
  sameWorkspaceEnv,
  spawnWorkspaceProcess,
} from "./index";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(path.join(here, "../../../index.html"), "utf8");
const bootstrapCss = readFileSync(
  path.join(here, "../../styles/workspace-bootstrap.css"),
  "utf8",
);

describe("Workspace process model", () => {
  beforeEach(() => {
    mocks.getCurrentWindow.mockReset();
    mocks.invoke.mockReset().mockResolvedValue(42);
  });

  it("keeps the bootstrap placeholder without forcing the window visible", () => {
    expect(indexHtml).toContain('id="workspace-bootstrap"');
    expect(indexHtml).toContain('href="/src/styles/workspace-bootstrap.css"');
    expect(indexHtml).not.toContain("<style");
    expect(indexHtml).not.toContain("plugin:window|show");
    expect(bootstrapCss).toContain("#workspace-bootstrap");
  });

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

  it("让原生命令从主窗口推导启动几何信息", async () => {
    await expect(
      spawnWorkspaceProcess({ kind: "ssh", profileId: "one" }, "recent"),
    ).resolves.toBe(42);

    expect(mocks.getCurrentWindow).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("spawn_workspace_process", {
      env: { kind: "ssh", profileId: "one" },
      policy: "recent",
      launchDir: null,
    });
  });
});
