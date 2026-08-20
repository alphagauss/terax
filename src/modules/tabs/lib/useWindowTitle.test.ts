/**
 * 本文件测试 Workspace 窗口标题的纯格式化规则。
 * 锁定主窗口不显示内部 ID、临时窗口短 ID 和 SSH endpoint 展示方式。
 */

import type { SshProfile } from "@/modules/remote";
import type { WorkspaceBootstrap } from "@/modules/workspace-process";
import { describe, expect, it } from "vitest";
import { formatWindowTitle } from "./useWindowTitle";

const labels = {
  local: "Local",
  temporary: (id: string) => `Temp ${id}`,
};

function bootstrap(
  env: WorkspaceBootstrap["env"],
  isPrimary = true,
): Pick<WorkspaceBootstrap, "env" | "id" | "isPrimary"> {
  return {
    env,
    id: "12345678-abcd-4abc-8abc-1234567890ab",
    isPrimary,
  };
}

const profile: SshProfile = {
  id: "ssh-profile-id",
  groupId: "default",
  name: "Server",
  host: "192.168.1.1",
  port: 22,
  username: "root",
  authMethod: "password",
  reconnectEnabled: true,
  reconnectMaxAttempts: 2,
  tunnels: [],
};

describe("formatWindowTitle", () => {
  it("主窗口只显示环境和激活页标题", () => {
    expect(
      formatWindowTitle(
        bootstrap({ kind: "local" }),
        "AGENTS.md",
        undefined,
        labels,
      ),
    ).toBe("Local · AGENTS.md");
    expect(
      formatWindowTitle(
        bootstrap({ kind: "wsl", distro: "Ubuntu-24.04" }),
        "Terminal",
        undefined,
        labels,
      ),
    ).toBe("WSL Ubuntu-24.04 · Terminal");
  });

  it("临时窗口在环境后显示 Workspace 短 ID", () => {
    expect(
      formatWindowTitle(
        bootstrap({ kind: "local" }, false),
        "AGENTS.md",
        undefined,
        labels,
      ),
    ).toBe("Local · Temp 12345678 · AGENTS.md");
  });

  it("SSH 使用 endpoint 且只显示非默认端口", () => {
    const ssh = bootstrap({ kind: "ssh", profileId: profile.id });
    expect(formatWindowTitle(ssh, "Terminal", profile, labels)).toBe(
      "SSH root@192.168.1.1 · Terminal",
    );
    expect(
      formatWindowTitle(ssh, "Terminal", { ...profile, port: 2222 }, labels),
    ).toBe("SSH root@192.168.1.1:2222 · Terminal");
  });

  it("SSH 配置尚未加载时不回退显示内部 profile ID", () => {
    expect(
      formatWindowTitle(
        bootstrap({ kind: "ssh", profileId: profile.id }),
        undefined,
        undefined,
        labels,
      ),
    ).toBe("SSH");
  });
});
