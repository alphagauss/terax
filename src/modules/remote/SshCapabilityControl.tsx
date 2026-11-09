/**
 * 本文件实现 SSH Workspace 状态栏能力灯和服务器命令详情弹层。
 * 快照严格绑定连接 epoch；自动探测不阻塞 Workspace，用户可以显式重新检测当前连接。
 */

import { CapabilityPopover } from "@/modules/statusbar/CapabilityPopover";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { useEffect, useRef, useState } from "react";
import { remoteNative } from "./native";
import { useRemoteRuntimeStore } from "./runtimeStore";
import type { SshCapabilitySnapshot } from "./types";

const EMPTY_CAPABILITIES: SshCapabilitySnapshot = {
  epoch: null,
  state: "unknown",
  checkedAt: null,
  commands: [],
  features: [],
};

/** 展示当前 SSH epoch 的统一服务器能力，并允许用户在安装依赖后重新检测。 */
export function SshCapabilityControl() {
  const env = useWorkspaceEnvStore((state) => state.env);
  const runtime = useRemoteRuntimeStore((state) => state.snapshot);
  const epoch =
    env.kind === "ssh" &&
    runtime.phase === "connected" &&
    runtime.profileId === env.profileId
      ? runtime.epoch
      : null;
  const [snapshot, setSnapshot] = useState(EMPTY_CAPABILITIES);
  const [recheckingEpoch, setRecheckingEpoch] = useState<number | null>(null);
  const currentEpoch = useRef(epoch);
  currentEpoch.current = epoch;
  const rechecking = recheckingEpoch === epoch;

  useEffect(() => {
    if (epoch === null) {
      setSnapshot(EMPTY_CAPABILITIES);
      return;
    }
    let active = true;
    let eventSeen = false;
    let unlisten: (() => void) | undefined;
    const apply = (next: SshCapabilitySnapshot) => {
      if (active && next.epoch === epoch) setSnapshot(next);
    };
    void (async () => {
      unlisten = await remoteNative.onCapabilities((next) => {
        if (next.epoch === epoch) eventSeen = true;
        apply(next);
      });
      if (!active) {
        unlisten();
        return;
      }
      const initial = await remoteNative.capabilitiesSnapshot();
      if (!eventSeen) apply(initial);
    })().catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [epoch]);

  const current = snapshot.epoch === epoch ? snapshot : EMPTY_CAPABILITIES;
  if (epoch === null) return null;

  const recheck = async () => {
    if (rechecking) return;
    setRecheckingEpoch(epoch);
    try {
      const next = await remoteNative.reprobeCapabilities();
      if (currentEpoch.current === epoch && next.epoch === epoch) {
        setSnapshot(next);
      }
    } catch {
      // 后端会同步发布 unknown 快照；这里避免点击事件产生未处理拒绝。
    } finally {
      setRecheckingEpoch((current) => (current === epoch ? null : current));
    }
  };
  return (
    <CapabilityPopover
      kind="ssh"
      report={current}
      rechecking={rechecking}
      onRecheck={recheck}
    />
  );
}
