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
import type { TunnelInfo } from "./types";

export function TunnelStatusControl() {
  const { t } = useTranslation("statusbar");
  const env = useWorkspaceEnvStore((state) => state.env);
  const profiles = useRemoteStore((state) => state.profiles);
  const isPrimary = currentWorkspaceBootstrap().isPrimary;
  const [open, setOpen] = useState(false);
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [operationError, setOperationError] = useState<string | null>(null);
  const lifecycleRevision = useRef(0);
  const profileId = env.kind === "ssh" ? env.profileId : null;
  const profile = useMemo(
    () => profiles.find((item) => item.id === profileId) ?? null,
    [profileId, profiles],
  );
  const lifecycleError =
    operationError ??
    tunnels.find((tunnel) => tunnel.status === "failed" || tunnel.error)
      ?.error ??
    (tunnels.some((tunnel) => tunnel.status === "failed")
      ? t("tunnels.status.failed")
      : null);

  const refresh = useCallback(async () => {
    const revision = ++lifecycleRevision.current;
    if (!profileId || !isPrimary) {
      setTunnels([]);
      setOperationError(null);
      return;
    }
    try {
      const next = await remoteNative.listTunnels(profileId);
      if (lifecycleRevision.current !== revision) return;
      next.sort((left, right) => left.id - right.id);
      setTunnels(next);
      setOperationError(null);
    } catch (cause) {
      if (lifecycleRevision.current === revision) {
        setOperationError(String(cause));
      }
    }
  }, [isPrimary, profileId]);

  useEffect(() => {
    if (!profileId || !isPrimary) {
      setTunnels([]);
      setOperationError(null);
      return;
    }
    let active = true;
    let unlisten: (() => void) | undefined;
    lifecycleRevision.current += 1;
    setTunnels([]);
    setOperationError(null);
    void (async () => {
      try {
        const next = await remoteNative.onTunnel((event) => {
          if (!active || event.profileId !== profileId) return;
          lifecycleRevision.current += 1;
          setTunnels((current) => applyTunnelEvent(current, event));
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
        className={cn(
          "flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground",
          lifecycleError && "text-destructive",
        )}
        title={lifecycleError ?? t("tunnels.label")}
      >
        <HugeiconsIcon icon={Route01Icon} size={13} strokeWidth={1.75} />
        <span>
          {tunnels.length
            ? t("tunnels.count", { count: tunnels.length })
            : t("tunnels.label")}
        </span>
      </button>
      <TunnelManagerDialog
        open={open}
        onOpenChange={setOpen}
        profileId={profileId}
        profileName={profile?.name ?? profileId}
        tunnels={tunnels}
        lifecycleError={lifecycleError}
        refresh={refresh}
      />
    </>
  );
}
