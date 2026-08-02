/**
 * 本文件测试 SSH 配置 store 的跨键持久化与冷启动读取规则。
 * 锁定原子分组变更、并发加载复用，以及配置与 Runtime 状态的职责分离。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SshProfile } from "./types";

const mocks = vi.hoisted(() => ({
  mutateSharedStore: vi.fn(async () => {}),
  readSharedStore: vi.fn(async () => ({})),
  runtimeSnapshot: vi.fn(async () => ({ phase: "idle", version: 0 })),
}));

vi.mock("@/lib/sharedStore", () => ({
  deleteSharedStoreKey: vi.fn(async () => {}),
  mutateSharedStore: mocks.mutateSharedStore,
  onSharedStoreChange: vi.fn(async () => () => {}),
  readSharedStore: mocks.readSharedStore,
  setSharedStoreKey: vi.fn(async () => {}),
}));

vi.mock("./native", () => ({
  remoteNative: {
    deleteSecrets: vi.fn(async () => {}),
    disconnectRuntime: vi.fn(async () => {}),
    runtimeSnapshot: mocks.runtimeSnapshot,
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

  it("reuses cached and in-flight profile loads during cold startup", async () => {
    useRemoteStore.setState({
      groups: [],
      profiles: [],
      loaded: false,
    });

    await Promise.all([
      useRemoteStore.getState().load(),
      useRemoteStore.getState().load(),
    ]);
    await useRemoteStore.getState().load();

    expect(mocks.readSharedStore).toHaveBeenCalledOnce();
  });

  it("uses two reconnect attempts when a legacy profile omits the value", async () => {
    mocks.readSharedStore.mockResolvedValueOnce({
      "profile:web": {
        ...profile("web", DEFAULT_SSH_GROUP_ID),
        reconnectMaxAttempts: undefined,
      },
    });
    useRemoteStore.setState({
      groups: [],
      profiles: [],
      loaded: false,
    });

    await useRemoteStore.getState().load();

    expect(useRemoteStore.getState().profiles[0]?.reconnectMaxAttempts).toBe(2);
  });

  it("does not treat a mutation before the first read as a loaded snapshot", async () => {
    useRemoteStore.setState({
      groups: [],
      profiles: [],
      loaded: false,
    });

    await useRemoteStore
      .getState()
      .saveProfile(profile("web", DEFAULT_SSH_GROUP_ID));

    expect(useRemoteStore.getState().loaded).toBe(false);
  });
});
