/**
 * 本文件实现状态栏 Workspace 环境选择器。
 * SSH 配置按分组进入二级菜单，连接仍通过稳定 profile ID 启动独立进程。
 */

import { Hint } from "@/components/controls/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { useRemoteRuntimeStore, useRemoteStore } from "@/modules/remote";
import { groupSshProfiles } from "@/modules/remote/groups";
import {
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import Refresh01Icon from "@hugeicons/core-free-icons/Refresh01Icon";
import ServerStack03Icon from "@hugeicons/core-free-icons/ServerStack03Icon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  onSelect: (env: WorkspaceEnv) => void;
  connectionError?: string | null;
  onCurrentConnected: () => Promise<string | null>;
  onCurrentReconnect: () => void;
};

const COMPACT_MENU_CONTENT = "min-w-52 rounded-xl p-1";
const COMPACT_MENU_ITEM = "h-7 gap-1.5 rounded-lg px-2 text-[13px] font-normal";
const COMPACT_MENU_SEPARATOR = "-mx-1 my-1";
const COMPACT_MENU_SUB_TRIGGER =
  "h-7 gap-1.5 rounded-lg px-2 text-[13px] font-normal";
const COMPACT_SSH_MENU_ITEM =
  "min-h-10 gap-1.5 rounded-lg px-2 py-1 text-[12px] font-semibold";

/** 在状态栏展示当前环境与 SSH Runtime 状态，并提供环境选择和共享重连入口。 */
export function WorkspaceEnvSelector({
  onSelect,
  connectionError = null,
  onCurrentConnected,
  onCurrentReconnect,
}: Props) {
  const { t } = useTranslation("statusbar");
  const env = useWorkspaceEnvStore((state) => state.env);
  const distros = useWorkspaceEnvStore((state) => state.distros);
  const loading = useWorkspaceEnvStore((state) => state.loading);
  const error = useWorkspaceEnvStore((state) => state.error);
  const refreshDistros = useWorkspaceEnvStore((state) => state.refreshDistros);
  const profiles = useRemoteStore((state) => state.profiles);
  const groups = useRemoteStore((state) => state.groups);
  const loadProfiles = useRemoteStore((state) => state.load);
  const runtime = useRemoteRuntimeStore((state) => state.snapshot);

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
  const connectionStatus =
    env.kind === "ssh" &&
    runtime.phase !== "idle" &&
    runtime.profileId === env.profileId
      ? runtime.phase
      : "disconnected";
  const groupedProfiles = useMemo(
    () => groupSshProfiles(groups, profiles),
    [groups, profiles],
  );

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
  const triggerTitle =
    env.kind === "ssh"
      ? [
          `${label}: ${t(`workspace.connectionStatus.${connectionStatus}`)}`,
          connectionError,
        ]
          .filter(Boolean)
          .join("\n")
      : t("workspace.environment");

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <Hint content={triggerTitle}>
            <button
              aria-label={triggerTitle}
              type="button"
              className="status-bar-item text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-accent data-[state=open]:text-foreground"
            >
              <HugeiconsIcon icon={ServerStack03Icon} strokeWidth={1.75} />
              {env.kind === "ssh" ? (
                <>
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      connectionStatus === "connected" && "bg-success",
                      (connectionStatus === "connecting" ||
                        connectionStatus === "reconnecting") &&
                        "animate-pulse bg-warning motion-reduce:animate-none",
                      connectionStatus === "disconnected" &&
                        "bg-muted-foreground/50",
                    )}
                  />
                  <span className="sr-only">
                    {t(`workspace.connectionStatus.${connectionStatus}`)}
                  </span>
                </>
              ) : null}
              <span className="whitespace-nowrap">{label}</span>
            </button>
          </Hint>
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
              onSelect={onCurrentReconnect}
              className={COMPACT_MENU_ITEM}
            >
              {t("common:remoteWorkspace.reconnectAction")}
            </DropdownMenuItem>
          ) : null}
          {connectionError && env.kind !== "ssh" ? (
            <DropdownMenuItem
              onSelect={() => {
                void onCurrentConnected();
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
    </>
  );
}
