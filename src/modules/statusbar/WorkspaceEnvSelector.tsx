/**
 * 本文件实现状态栏 Workspace 环境选择器。
 * SSH 配置按分组进入二级菜单，连接仍通过稳定 profile ID 启动独立进程。
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IS_WINDOWS } from "@/lib/platform";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  remoteNative,
  SshConnectionDialog,
  useRemoteStore,
} from "@/modules/remote";
import { groupSshProfiles } from "@/modules/remote/groups";
import {
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import {
  Folder01Icon,
  Refresh01Icon,
  ServerStack03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  onSelect: (env: WorkspaceEnv) => void;
  connectionError?: string | null;
  onCurrentConnected?: () => Promise<string | null>;
};

const COMPACT_MENU_CONTENT = "min-w-52 rounded-xl p-1";
const COMPACT_MENU_ITEM = "h-7 gap-1.5 rounded-lg px-2 text-[13px] font-normal";
const COMPACT_MENU_SEPARATOR = "-mx-1 my-1";
const COMPACT_MENU_SUB_TRIGGER =
  "h-7 gap-1.5 rounded-lg px-2 text-[13px] font-normal";
const COMPACT_SSH_MENU_ITEM =
  "min-h-10 gap-1.5 rounded-lg px-2 py-1 text-[12px] font-semibold";

/** 在状态栏展示当前环境，并提供本地、WSL 与分组 SSH Workspace 入口。 */
export function WorkspaceEnvSelector({
  onSelect,
  connectionError = null,
  onCurrentConnected,
}: Props) {
  const { t } = useTranslation("statusbar");
  const env = useWorkspaceEnvStore((state) => state.env);
  const distros = useWorkspaceEnvStore((state) => state.distros);
  const loading = useWorkspaceEnvStore((state) => state.loading);
  const error = useWorkspaceEnvStore((state) => state.error);
  const refreshDistros = useWorkspaceEnvStore((state) => state.refreshDistros);
  const profiles = useRemoteStore((state) => state.profiles);
  const groups = useRemoteStore((state) => state.groups);
  const statuses = useRemoteStore((state) => state.statuses);
  const loadProfiles = useRemoteStore((state) => state.load);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const promptedError = useRef<string | null>(null);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const activeProfile = useMemo(
    () =>
      env.kind === "ssh"
        ? profiles.find((profile) => profile.id === env.profileId)
        : undefined,
    [env, profiles],
  );
  const activeStatus =
    env.kind === "ssh" ? statuses[env.profileId]?.status : undefined;
  const groupedProfiles = useMemo(
    () => groupSshProfiles(groups, profiles),
    [groups, profiles],
  );

  useEffect(() => {
    if (env.kind !== "ssh" || !activeProfile || !connectionError) {
      if (!connectionError) promptedError.current = null;
      return;
    }
    const fingerprint = `${env.profileId}:${connectionError}`;
    if (promptedError.current === fingerprint) return;
    promptedError.current = fingerprint;
    setConnectionOpen(true);
  }, [activeProfile, connectionError, env]);

  useEffect(() => {
    if (env.kind !== "ssh") setConnectionOpen(false);
  }, [env]);

  const handleOpenChange = (open: boolean) => {
    if (IS_WINDOWS && open && distros.length === 0 && !loading) {
      void refreshDistros();
    }
  };

  const label =
    env.kind === "wsl"
      ? t("workspace.wslDistro", { distro: env.distro })
      : env.kind === "ssh"
        ? t("workspace.sshProfile", {
            name: activeProfile?.name ?? env.profileId,
          })
        : IS_WINDOWS
          ? t("workspace.windows")
          : t("workspace.local");

  const reconnectCurrent = () => {
    if (env.kind !== "ssh") return;
    void remoteNative
      .reconnect(env.profileId)
      .then(async () => {
        if (!(await onCurrentConnected?.())) setConnectionOpen(true);
      })
      .catch(() => setConnectionOpen(true));
  };

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-accent data-[state=open]:text-foreground"
            title={t("workspace.environment")}
          >
            <HugeiconsIcon
              icon={ServerStack03Icon}
              size={13}
              strokeWidth={1.75}
            />
            {env.kind === "ssh" ? (
              <span
                className={`size-1.5 rounded-full ${
                  activeStatus === "connected"
                    ? "bg-emerald-500"
                    : activeStatus === "error"
                      ? "bg-destructive"
                      : activeStatus === "connecting" ||
                          activeStatus === "reconnecting"
                        ? "bg-amber-500"
                        : "bg-muted-foreground/50"
                }`}
              />
            ) : null}
            <span className="max-w-36 truncate">{label}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={COMPACT_MENU_CONTENT}>
          <DropdownMenuItem
            onSelect={() => onSelect(LOCAL_WORKSPACE)}
            className={COMPACT_MENU_ITEM}
          >
            {IS_WINDOWS ? t("workspace.windowsLocal") : t("workspace.local")}
          </DropdownMenuItem>
          {IS_WINDOWS ? (
            <>
              <DropdownMenuSeparator className={COMPACT_MENU_SEPARATOR} />
              {distros.length === 0 ? (
                <DropdownMenuItem disabled className={COMPACT_MENU_ITEM}>
                  {loading
                    ? t("workspace.loadingWslDistros")
                    : error
                      ? t("workspace.wslUnavailable")
                      : t("workspace.noWslDistros")}
                </DropdownMenuItem>
              ) : (
                distros.map((distro) => (
                  <DropdownMenuItem
                    key={distro.name}
                    onSelect={() =>
                      onSelect({ kind: "wsl", distro: distro.name })
                    }
                    className={COMPACT_MENU_ITEM}
                  >
                    {t("workspace.wslDistro", { distro: distro.name })}
                  </DropdownMenuItem>
                ))
              )}
            </>
          ) : null}
          <DropdownMenuSeparator className={COMPACT_MENU_SEPARATOR} />
          {profiles.length === 0 ? (
            <DropdownMenuItem disabled className={COMPACT_MENU_ITEM}>
              {t("workspace.noSshProfiles")}
            </DropdownMenuItem>
          ) : (
            groupedProfiles
              .filter((group) => group.profiles.length > 0)
              .map((group) => (
                <DropdownMenuSub key={group.id}>
                  <DropdownMenuSubTrigger className={COMPACT_MENU_SUB_TRIGGER}>
                    <HugeiconsIcon
                      icon={Folder01Icon}
                      size={13}
                      strokeWidth={1.75}
                    />
                    <span className="max-w-40 truncate">
                      {group.name ?? t("workspace.defaultSshGroup")}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-(--radix-dropdown-menu-content-available-height) min-w-44 max-w-64 overflow-y-auto rounded-xl p-1">
                    {group.profiles.map((profile) => {
                      const active =
                        env.kind === "ssh" && env.profileId === profile.id;
                      return (
                        <DropdownMenuItem
                          key={profile.id}
                          onSelect={() =>
                            onSelect({
                              kind: "ssh",
                              profileId: profile.id,
                            })
                          }
                          className={COMPACT_SSH_MENU_ITEM}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate leading-tight">
                              {profile.name}
                            </span>
                            <span className="block truncate font-mono text-[11px] leading-tight font-normal text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground/70">
                              {profile.username}@{profile.host}:{profile.port}
                            </span>
                          </span>
                          {active ? (
                            <HugeiconsIcon
                              icon={Tick02Icon}
                              size={13}
                              strokeWidth={2}
                              className="ml-auto"
                            />
                          ) : null}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ))
          )}
          <DropdownMenuSeparator className={COMPACT_MENU_SEPARATOR} />
          <DropdownMenuItem
            onSelect={() => void openSettingsWindow("remote")}
            className={COMPACT_MENU_ITEM}
          >
            {t("workspace.manageSshProfiles")}
          </DropdownMenuItem>
          {env.kind === "ssh" ? (
            <DropdownMenuItem
              onSelect={reconnectCurrent}
              className={COMPACT_MENU_ITEM}
            >
              {t("workspace.reconnectCurrentSsh")}
            </DropdownMenuItem>
          ) : null}
          {connectionError ? (
            <DropdownMenuItem
              onSelect={() => {
                if (env.kind === "ssh") {
                  setConnectionOpen(true);
                  return;
                }
                void onCurrentConnected?.();
              }}
              className={COMPACT_MENU_ITEM}
            >
              {t("workspace.retryCurrentEnvironment")}
            </DropdownMenuItem>
          ) : null}
          {IS_WINDOWS ? (
            <>
              <DropdownMenuSeparator className={COMPACT_MENU_SEPARATOR} />
              <DropdownMenuItem
                onSelect={() => void refreshDistros()}
                className={COMPACT_MENU_ITEM}
              >
                <HugeiconsIcon
                  icon={Refresh01Icon}
                  size={13}
                  strokeWidth={1.75}
                />
                {t("workspace.refreshWsl")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <SshConnectionDialog
        open={connectionOpen}
        onOpenChange={setConnectionOpen}
        profileId={env.kind === "ssh" ? env.profileId : null}
        onConnected={async () => (await onCurrentConnected?.()) ?? null}
      />
    </>
  );
}
