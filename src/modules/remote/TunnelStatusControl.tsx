/**
 * 本文件在状态栏汇总 SSH 隧道状态并打开持久化隧道管理面板。
 * 状态栏只显示总数和失败数，单条运行状态统一由面板列表中的状态点表达。
 */

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { currentWorkspaceBootstrap } from "@/modules/workspace-process";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { Route01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TunnelManagerDialog } from "./TunnelManagerDialog";
import { remoteNative } from "./native";
import { useRemoteStore } from "./store";
import { applyTunnelEvent, tunnelEventError } from "./tunnelEvents";
import type { SshTunnel, TunnelInfo } from "./types";

/** 展示当前主 SSH Workspace 的隧道概览并协调运行时事件。 */
export function TunnelStatusControl() {
  const { t } = useTranslation("statusbar");
  const env = useWorkspaceEnvStore((state) => state.env);
  const profiles = useRemoteStore((state) => state.profiles);
  const saveProfile = useRemoteStore((state) => state.saveProfile);
  const isPrimary = currentWorkspaceBootstrap().isPrimary;
  const [open, setOpen] = useState(false);
  const [runtimeTunnels, setRuntimeTunnels] = useState<TunnelInfo[]>([]);
  const [operationError, setOperationError] = useState<string | null>(null);
  const lifecycleRevision = useRef(0);
  const profileId = env.kind === "ssh" ? env.profileId : null;
  const profile = useMemo(
    () => profiles.find((item) => item.id === profileId) ?? null,
    [profileId, profiles],
  );
  const lifecycleError =
    operationError ??
    runtimeTunnels.find((tunnel) => tunnel.status === "failed" || tunnel.error)
      ?.error ??
    (runtimeTunnels.some((tunnel) => tunnel.status === "failed")
      ? t("tunnels.status.failed")
      : null);
  const failedCount = runtimeTunnels.filter(
    (tunnel) => tunnel.status === "failed" || tunnel.error,
  ).length;

  const refresh = useCallback(async () => {
    const revision = ++lifecycleRevision.current;
    if (!profileId || !isPrimary) {
      setRuntimeTunnels([]);
      setOperationError(null);
      return;
    }
    try {
      const next = await remoteNative.listTunnels(profileId);
      if (lifecycleRevision.current !== revision) return;
      next.sort((left, right) => left.id - right.id);
      setRuntimeTunnels(next);
      setOperationError(null);
    } catch (cause) {
      if (lifecycleRevision.current === revision) {
        setOperationError(String(cause));
      }
    }
  }, [isPrimary, profileId]);

  useEffect(() => {
    if (!profileId || !isPrimary) {
      setRuntimeTunnels([]);
      setOperationError(null);
      return;
    }
    let active = true;
    let unlisten: (() => void) | undefined;
    lifecycleRevision.current += 1;
    setRuntimeTunnels([]);
    setOperationError(null);
    void (async () => {
      try {
        const next = await remoteNative.onTunnel((event) => {
          if (!active || event.profileId !== profileId) return;
          lifecycleRevision.current += 1;
          setRuntimeTunnels((current) => applyTunnelEvent(current, event));
          if (event.kind === "failed") {
            setOperationError(
              tunnelEventError(event) ?? t("tunnels.status.failed"),
            );
          } else {
            setOperationError(null);
          }
        });
        if (!active) {
          next();
          return;
        }
        unlisten = next;
        await refresh();
      } catch (cause) {
        if (active) setOperationError(String(cause));
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [isPrimary, profileId, refresh, t]);

  /** 将隧道定义写回当前 profile，不修改其他 SSH 配置字段。 */
  const saveTunnels = useCallback(
    async (tunnels: SshTunnel[]) => {
      if (!profile) return;
      await saveProfile({ ...profile, tunnels });
    },
    [profile, saveProfile],
  );

  if (!profileId) return null;

  if (!isPrimary) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex h-6 items-center rounded-sm px-1.5 text-muted-foreground/55">
            <HugeiconsIcon icon={Route01Icon} size={13} strokeWidth={1.75} />
            <span className="sr-only">{t("tunnels.label")}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 text-[11px]">
          {t("tunnels.managedByPrimary")}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        title={lifecycleError ?? t("tunnels.label")}
      >
        <HugeiconsIcon icon={Route01Icon} size={13} strokeWidth={1.75} />
        <span>{t("tunnels.count", { count: profile?.tunnels.length ?? 0 })}</span>
        {failedCount ? (
          <span className={cn("text-destructive", lifecycleError && "font-medium")}>
            {t("tunnels.failedCount", { count: failedCount })}
          </span>
        ) : null}
      </button>
      <TunnelManagerDialog
        open={open}
        onOpenChange={setOpen}
        profileId={profileId}
        profileName={profile?.name ?? profileId}
        tunnels={profile?.tunnels ?? []}
        runtimeTunnels={runtimeTunnels}
        lifecycleError={lifecycleError}
        saveTunnels={saveTunnels}
        refresh={refresh}
      />
    </>
  );
}
