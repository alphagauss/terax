/**
 * 本文件验证 Workspace 进程环境选择和冷启动显示顺序。
 * HTML 只提供轻量冷启动占位，不得绕过原生环境判断主动显示窗口。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { policyForEnvironmentSelection, sameWorkspaceEnv } from "./index";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(path.join(here, "../../../index.html"), "utf8");

describe("Workspace process model", () => {
  it("keeps the bootstrap placeholder without forcing the window visible", () => {
    expect(indexHtml).toContain('id="workspace-bootstrap"');
    expect(indexHtml).not.toContain("plugin:window|show");
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
});
