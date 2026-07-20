import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { currentWorkspaceBootstrap } from "@/modules/workspace-process";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { Route01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TunnelManagerDialog } from "./TunnelManagerDialog";
import { remoteNative } from "./native";
import { useRemoteStore } from "./store";
import type { TunnelInfo } from "./types";

export function TunnelStatusControl() {
  const { t } = useTranslation("statusbar");
  const env = useWorkspaceEnvStore((state) => state.env);
  const profiles = useRemoteStore((state) => state.profiles);
  const loadProfiles = useRemoteStore((state) => state.load);
  const isPrimary = currentWorkspaceBootstrap().isPrimary;
  const [open, setOpen] = useState(false);
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const profileId = env.kind === "ssh" ? env.profileId : null;
  const profile = useMemo(
    () => profiles.find((item) => item.id === profileId) ?? null,
    [profileId, profiles],
  );

  useEffect(() => {
    if (profileId) void loadProfiles();
  }, [loadProfiles, profileId]);

  const refresh = useCallback(async () => {
    if (!profileId || !isPrimary) {
      setTunnels([]);
      return;
    }
    try {
      setTunnels(await remoteNative.listTunnels(profileId));
    } catch {
      setTunnels([]);
    }
  }, [isPrimary, profileId]);

  useEffect(() => {
    if (!profileId || !isPrimary) {
      setTunnels([]);
      return;
    }
    let active = true;
    let unlisten: (() => void) | undefined;
    void refresh();
    void remoteNative
      .onTunnel((event) => {
        if (active && event.profileId === profileId) void refresh();
      })
      .then((next) => {
        if (active) unlisten = next;
        else next();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [isPrimary, profileId, refresh]);

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
        title={t("tunnels.label")}
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
        refresh={refresh}
      />
    </>
  );
}
