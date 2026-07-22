/**
 * 本文件测试 SSH 配置 store 的跨键持久化规则。
 * 锁定删除分组时配置归入默认组并通过一次原子批量变更提交。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SshProfile } from "./types";

const mocks = vi.hoisted(() => ({
  mutateSharedStore: vi.fn(async () => {}),
}));

vi.mock("@/lib/sharedStore", () => ({
  deleteSharedStoreKey: vi.fn(async () => {}),
  mutateSharedStore: mocks.mutateSharedStore,
  onSharedStoreChange: vi.fn(async () => () => {}),
  readSharedStore: vi.fn(async () => ({})),
  setSharedStoreKey: vi.fn(async () => {}),
}));

vi.mock("./native", () => ({
  remoteNative: {
    deleteSecrets: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    status: vi.fn(async () => ({ status: "disconnected" })),
  },
}));

import { DEFAULT_SSH_GROUP_ID } from "./groups";
import { useRemoteStore } from "./store";

function profile(id: string, groupId: string): SshProfile {
  return {
    id,
    groupId,
    name: id,
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

describe("SSH remote store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRemoteStore.setState({
      groups: [{ id: "prod", name: "Production" }],
      profiles: [profile("web", "prod"), profile("home", DEFAULT_SSH_GROUP_ID)],
      statuses: {},
      loaded: true,
    });
  });

  it("moves group members to default in the same mutation that deletes the group", async () => {
    await useRemoteStore.getState().deleteGroup("prod");

    expect(mocks.mutateSharedStore).toHaveBeenCalledWith("ssh-profiles", [
      {
        kind: "set",
        key: "profile:web",
        value: expect.objectContaining({
          id: "web",
          groupId: DEFAULT_SSH_GROUP_ID,
        }),
      },
      { kind: "delete", key: "group:prod" },
    ]);
    expect(useRemoteStore.getState().groups).toEqual([]);
    expect(useRemoteStore.getState().profiles[0].groupId).toBe(
      DEFAULT_SSH_GROUP_ID,
    );
  });
});
