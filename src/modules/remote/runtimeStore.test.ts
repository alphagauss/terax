/**
 * 本文件测试 Remote Runtime 前端投影的版本与收敛规则。
 * 锁定迟到快照不能回滚状态，且只有 connected 快照能够提供可用 Home。
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  connectedRuntimeHome,
  useRemoteRuntimeStore,
  waitForRuntimeSettlement,
} from "./runtimeStore";

describe("Remote Runtime store", () => {
  beforeEach(() => {
    useRemoteRuntimeStore.setState({
      snapshot: { phase: "idle", version: 0 },
    });
  });

  it("rejects snapshots older than the current Rust version", () => {
    const apply = useRemoteRuntimeStore.getState().applySnapshot;
    apply({
      phase: "connected",
      version: 4,
      epoch: 2,
      profileId: "server",
      home: "/home/me",
    });
    apply({
      phase: "disconnected",
      version: 3,
      profileId: "server",
      reason: "late event",
    });

    expect(useRemoteRuntimeStore.getState().snapshot).toMatchObject({
      phase: "connected",
      version: 4,
      epoch: 2,
    });
  });

  it("waits for connecting to settle on the next connected epoch", async () => {
    const apply = useRemoteRuntimeStore.getState().applySnapshot;
    apply({
      phase: "connecting",
      version: 1,
      profileId: "server",
    });
    const settlement = waitForRuntimeSettlement();
    apply({
      phase: "connected",
      version: 2,
      epoch: 1,
      profileId: "server",
      home: "/home/me",
    });

    await expect(settlement).resolves.toBe("/home/me");
  });

  it("waits across automatic reconnect attempts until the runtime settles", async () => {
    const apply = useRemoteRuntimeStore.getState().applySnapshot;
    apply({
      phase: "reconnecting",
      version: 1,
      profileId: "server",
    });
    const settlement = waitForRuntimeSettlement();
    apply({
      phase: "disconnected",
      version: 2,
      profileId: "server",
      reason: "offline",
    });

    await expect(settlement).resolves.toBeNull();
  });

  it("does not expose the historical Home of a disconnected runtime", () => {
    expect(
      connectedRuntimeHome({
        phase: "disconnected",
        version: 2,
        profileId: "server",
        reason: "closed",
      }),
    ).toBeNull();
  });
});
