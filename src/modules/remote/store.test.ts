/**
 * 本文件测试 SSH 配置 store 的跨键持久化与冷启动读取规则。
 * 锁定原子分组变更、并发加载复用，以及状态查询完成前不得提前返回。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionInfo, SshProfile } from "./types";

const mocks = vi.hoisted(() => ({
  mutateSharedStore: vi.fn(async () => {}),
  readSharedStore: vi.fn(async () => ({})),
  status: vi.fn(async (profileId: string) => ({
    profileId,
    status: "disconnected",
  })),
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
    disconnect: vi.fn(async () => {}),
    status: mocks.status,
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

  it("reuses cached and in-flight profile loads during cold startup", async () => {
    useRemoteStore.setState({
      groups: [],
      profiles: [],
      statuses: {},
      loaded: false,
    });

    await Promise.all([
      useRemoteStore.getState().load(),
      useRemoteStore.getState().load(),
    ]);
    await useRemoteStore.getState().load();

    expect(mocks.readSharedStore).toHaveBeenCalledOnce();
  });

  it("waits for the in-flight status snapshot even after profiles are loaded", async () => {
    let resolveStatus: ((status: ConnectionInfo) => void) | undefined;
    mocks.readSharedStore.mockResolvedValueOnce({
      "profile:web": profile("web", DEFAULT_SSH_GROUP_ID),
    });
    mocks.status.mockImplementationOnce(
      (profileId: string) =>
        new Promise((resolve) => {
          expect(profileId).toBe("web");
          resolveStatus = resolve;
        }),
    );
    useRemoteStore.setState({
      groups: [],
      profiles: [],
      statuses: {},
      loaded: false,
    });

    const first = useRemoteStore.getState().load();
    await vi.waitFor(() => expect(resolveStatus).toBeTypeOf("function"));
    const second = useRemoteStore.getState().load();
    let secondResolved = false;
    void second.then(() => {
      secondResolved = true;
    });
    await Promise.resolve();

    expect(secondResolved).toBe(false);
    resolveStatus?.({ profileId: "web", status: "disconnected" });
    await Promise.all([first, second]);
    expect(mocks.readSharedStore).toHaveBeenCalledOnce();
  });

  it("does not treat a mutation before the first read as a loaded snapshot", async () => {
    useRemoteStore.setState({
      groups: [],
      profiles: [],
      statuses: {},
      loaded: false,
    });

    await useRemoteStore
      .getState()
      .saveProfile(profile("web", DEFAULT_SSH_GROUP_ID));

    expect(useRemoteStore.getState().loaded).toBe(false);
  });
});
