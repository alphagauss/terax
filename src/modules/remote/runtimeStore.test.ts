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
      credentialsRequired: false,
    });

    expect(useRemoteRuntimeStore.getState().snapshot).toMatchObject({
      phase: "connected",
      version: 4,
      epoch: 2,
    });
  });

  it("waits across connecting phases until the next connected epoch", async () => {
    const apply = useRemoteRuntimeStore.getState().applySnapshot;
    apply({
      phase: "connecting",
      version: 1,
      profileId: "server",
    });
    const settlement = waitForRuntimeSettlement();
    apply({
      phase: "reconnecting",
      version: 2,
      profileId: "server",
    });
    apply({
      phase: "connected",
      version: 3,
      epoch: 1,
      profileId: "server",
      home: "/home/me",
    });

    await expect(settlement).resolves.toBe("/home/me");
  });

  it("does not expose the historical Home of a disconnected runtime", () => {
    expect(
      connectedRuntimeHome({
        phase: "disconnected",
        version: 2,
        profileId: "server",
        reason: "closed",
        credentialsRequired: false,
      }),
    ).toBeNull();
  });
});
