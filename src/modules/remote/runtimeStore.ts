/**
 * 本文件保存当前进程唯一 SSH Runtime 的前端只读投影。
 * 仅接受 Rust 发布的单调版本快照，不推断连接状态，也不自行发起重连。
 */

import { create } from "zustand";
import type { RemoteRuntimeSnapshot } from "./types";

type RemoteRuntimeState = {
  snapshot: RemoteRuntimeSnapshot;
  applySnapshot: (snapshot: RemoteRuntimeSnapshot) => void;
};

/** 当前进程对 Rust Remote Runtime 权威快照的只读投影。 */
export const useRemoteRuntimeStore = create<RemoteRuntimeState>((set) => ({
  snapshot: { phase: "idle", version: 0 },
  applySnapshot: (snapshot) =>
    set((state) =>
      snapshot.version > state.snapshot.version ? { snapshot } : state,
    ),
}));

/** 返回已连接 Runtime 的 Home，其他阶段不把历史路径误作可用凭据。 */
export function connectedRuntimeHome(
  snapshot: RemoteRuntimeSnapshot,
): string | null {
  return snapshot.phase === "connected" ? snapshot.home : null;
}

/** 等待当前连接操作结束，并返回其最终可用 Home。 */
export function waitForRuntimeSettlement(): Promise<string | null> {
  const current = useRemoteRuntimeStore.getState().snapshot;
  if (current.phase !== "connecting" && current.phase !== "reconnecting") {
    return Promise.resolve(connectedRuntimeHome(current));
  }
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const settle = (snapshot: RemoteRuntimeSnapshot) => {
      if (
        settled ||
        snapshot.phase === "connecting" ||
        snapshot.phase === "reconnecting"
      )
        return;
      settled = true;
      unsubscribe();
      resolve(connectedRuntimeHome(snapshot));
    };
    unsubscribe = useRemoteRuntimeStore.subscribe((state) => {
      settle(state.snapshot);
    });
    // 订阅与首次读取之间可能已经完成连接，必须在订阅后再读一次。
    settle(useRemoteRuntimeStore.getState().snapshot);
  });
}
