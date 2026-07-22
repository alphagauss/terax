/**
 * 本文件测试 SSH 配置分组的纯数据规则。
 * 锁定默认组回落、稳定排序和分组名称唯一性。
 */

import { describe, expect, it } from "vitest";
import type { SshGroup, SshProfile } from "./types";
import {
  DEFAULT_SSH_GROUP_ID,
  groupNameIssue,
  groupSshProfiles,
} from "./groups";

function profile(id: string, name: string, groupId: string): SshProfile {
  return {
    id,
    groupId,
    name,
    host: `${id}.example.com`,
    port: 22,
    username: "deploy",
    authMethod: "agent",
    keepaliveSeconds: 30,
    reconnectEnabled: true,
    reconnectMaxAttempts: 5,
    tunnels: [],
  };
}

describe("SSH profile groups", () => {
  it("keeps the default group first and sorts groups and profiles by name", () => {
    const groups: SshGroup[] = [
      { id: "stage", name: "Staging" },
      { id: "prod", name: "Production" },
    ];
    const grouped = groupSshProfiles(groups, [
      profile("web-b", "Web B", "prod"),
      profile("local", "Local", DEFAULT_SSH_GROUP_ID),
      profile("web-a", "Web A", "prod"),
    ]);

    expect(grouped.map((group) => group.id)).toEqual([
      DEFAULT_SSH_GROUP_ID,
      "prod",
      "stage",
    ]);
    expect(grouped[1].profiles.map((item) => item.name)).toEqual([
      "Web A",
      "Web B",
    ]);
  });

  it("places profiles with an unknown group in the default group", () => {
    const grouped = groupSshProfiles(
      [],
      [profile("orphan", "Orphan", "deleted-group")],
    );
    expect(grouped[0].profiles[0].id).toBe("orphan");
  });

  it("requires a unique non-empty group name while editing", () => {
    const groups: SshGroup[] = [{ id: "prod", name: "Production" }];
    expect(groupNameIssue("  ", groups)).toBe("required");
    expect(groupNameIssue("production", groups)).toBe("duplicate");
    expect(groupNameIssue("Production", groups, "prod")).toBeNull();
  });
});
