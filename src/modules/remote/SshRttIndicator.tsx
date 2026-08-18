/**
 * 本文件实现状态栏中的低频 SSH RTT 指示器。
 * RTT 由 Rust 统一健康监督器采样，组件只读取当前 epoch 快照和事件。
 */

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { remoteNative } from "./native";
import { useRemoteRuntimeStore } from "./runtimeStore";
import type { SshHealthSnapshot } from "./types";

const EMPTY_HEALTH: SshHealthSnapshot = {
  epoch: null,
  rttMs: null,
  sampledAt: null,
};

/** 在当前 SSH Runtime 已连接时展示最近一次有效链路 RTT。 */
export function SshRttIndicator() {
  const { t } = useTranslation("statusbar");
  const env = useWorkspaceEnvStore((state) => state.env);
  const runtime = useRemoteRuntimeStore((state) => state.snapshot);
  const epoch =
    env.kind === "ssh" &&
    runtime.phase === "connected" &&
    runtime.profileId === env.profileId
      ? runtime.epoch
      : null;
  const [health, setHealth] = useState<SshHealthSnapshot>(EMPTY_HEALTH);

  useEffect(() => {
    if (epoch === null) {
      setHealth(EMPTY_HEALTH);
      return;
    }
    let active = true;
    let unlisten: (() => void) | undefined;
    const apply = (snapshot: SshHealthSnapshot) => {
      if (!active || snapshot.epoch !== epoch) return;
      setHealth((current) => {
        if (
          current.epoch === epoch &&
          (current.sampledAt ?? 0) > (snapshot.sampledAt ?? 0)
        ) {
          return current;
        }
        return snapshot;
      });
    };
    void (async () => {
      unlisten = await remoteNative.onHealth(apply);
      if (!active) {
        unlisten();
        return;
      }
      apply(await remoteNative.healthSnapshot());
    })().catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [epoch]);

  if (epoch === null) return null;
  const currentHealth = health.epoch === epoch ? health : EMPTY_HEALTH;
  const value =
    currentHealth.rttMs === null ? "--" : String(currentHealth.rttMs);
  const tooltip =
    currentHealth.rttMs === null
      ? t("sshRtt.pending")
      : t("sshRtt.tooltip", { value: currentHealth.rttMs });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex h-6 shrink-0 cursor-default items-center rounded-sm px-1 text-[11px] tabular-nums text-muted-foreground">
          {value} ms
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-[11px]">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
