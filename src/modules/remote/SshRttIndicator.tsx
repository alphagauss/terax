/**
 * 本文件实现状态栏中的 SSH RTT 与远程文件后端指示器。
 * RTT 和 Python capability 均由 Rust 按 epoch 发布，组件同步用户设置并拒绝迟到事件。
 */

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { remoteNative } from "./native";
import { useRemoteRuntimeStore } from "./runtimeStore";
import type { SshFileBackendSnapshot, SshHealthSnapshot } from "./types";

const EMPTY_HEALTH: SshHealthSnapshot = {
  epoch: null,
  rttMs: null,
  sampledAt: null,
};

const EMPTY_FILE_BACKEND: SshFileBackendSnapshot = {
  epoch: null,
  capability: "unavailable",
  activeBackend: "sftp",
  pythonVersion: null,
  enabled: false,
  fallback: false,
  latencyEligible: false,
  rttThresholdMs: 100,
};

/** 在当前 SSH Runtime 已连接时展示链路 RTT 和实际文件后端。 */
export function SshRttIndicator() {
  const { t } = useTranslation("statusbar");
  const env = useWorkspaceEnvStore((state) => state.env);
  const runtime = useRemoteRuntimeStore((state) => state.snapshot);
  const fileAcceleration = usePreferencesStore(
    (state) => state.sshFileAcceleration,
  );
  const preferencesHydrated = usePreferencesStore((state) => state.hydrated);
  const epoch =
    env.kind === "ssh" &&
    runtime.phase === "connected" &&
    runtime.profileId === env.profileId
      ? runtime.epoch
      : null;
  const [health, setHealth] = useState<SshHealthSnapshot>(EMPTY_HEALTH);
  const [fileBackend, setFileBackend] = useState<SshFileBackendSnapshot>(
    EMPTY_FILE_BACKEND,
  );

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

  useEffect(() => {
    if (epoch === null) {
      setFileBackend(EMPTY_FILE_BACKEND);
      return;
    }
    let active = true;
    let unlisten: (() => void) | undefined;
    const apply = (snapshot: SshFileBackendSnapshot) => {
      if (!active || snapshot.epoch !== epoch) return;
      setFileBackend(snapshot);
    };
    void (async () => {
      unlisten = await remoteNative.onFileBackend(apply);
      if (!active) {
        unlisten();
        return;
      }
      apply(await remoteNative.fileBackendSnapshot());
    })().catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [epoch]);

  useEffect(() => {
    if (epoch === null || !preferencesHydrated) return;
    void remoteNative
      .setFileBackendEnabled(fileAcceleration)
      .then((snapshot) => {
        if (snapshot.epoch === epoch) setFileBackend(snapshot);
      })
      .catch(() => undefined);
  }, [epoch, fileAcceleration, preferencesHydrated]);

  if (epoch === null) return null;
  const currentHealth = health.epoch === epoch ? health : EMPTY_HEALTH;
  const value =
    currentHealth.rttMs === null ? "--" : String(currentHealth.rttMs);
  const tooltip =
    currentHealth.rttMs === null
      ? t("sshRtt.pending")
      : t("sshRtt.tooltip", { value: currentHealth.rttMs });
  const currentFileBackend =
    fileBackend.epoch === epoch ? fileBackend : EMPTY_FILE_BACKEND;
  const showFileMarker = currentFileBackend.capability === "available";
  const fileTooltip = currentFileBackend.fallback
    ? t("sshFileBackend.fallback")
    : currentFileBackend.activeBackend === "python"
      ? t("sshFileBackend.python", {
          version: currentFileBackend.pythonVersion ?? "--",
        })
      : currentFileBackend.capability === "available" &&
          currentFileBackend.enabled &&
          !currentFileBackend.latencyEligible
        ? t("sshFileBackend.lowLatency", {
            threshold: currentFileBackend.rttThresholdMs,
          })
      : currentFileBackend.capability === "available"
        ? t("sshFileBackend.disabled", {
            version: currentFileBackend.pythonVersion ?? "--",
          })
        : t("sshFileBackend.sftp");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex h-6 shrink-0 cursor-default items-center gap-1 rounded-sm px-1 text-[11px] tabular-nums text-muted-foreground">
          <span>{value} ms</span>
          {showFileMarker ? (
            <span
              className={
                currentFileBackend.fallback
                  ? "font-medium text-amber-600 dark:text-amber-400"
                  : currentFileBackend.activeBackend === "python"
                    ? "font-medium text-primary"
                    : "text-muted-foreground/60"
              }
            >
              I/O
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-[11px]">
        <div>{tooltip}</div>
        <div className="mt-1 text-muted-foreground">{fileTooltip}</div>
      </TooltipContent>
    </Tooltip>
  );
}
