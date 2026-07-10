import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IS_WINDOWS } from "@/lib/platform";
import {
  HostKeyDialog,
  RemoteSshDialog,
  remoteNative,
  useRemoteStore,
  type HostKeyPrompt,
} from "@/modules/remote";
import {
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { Refresh01Icon, ServerStack03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";

type Props = {
  onSelect: (env: WorkspaceEnv) => void;
};

export function WorkspaceEnvSelector({ onSelect }: Props) {
  const env = useWorkspaceEnvStore((state) => state.env);
  const distros = useWorkspaceEnvStore((state) => state.distros);
  const loading = useWorkspaceEnvStore((state) => state.loading);
  const error = useWorkspaceEnvStore((state) => state.error);
  const refreshDistros = useWorkspaceEnvStore((state) => state.refreshDistros);
  const profiles = useRemoteStore((state) => state.profiles);
  const statuses = useRemoteStore((state) => state.statuses);
  const loadProfiles = useRemoteStore((state) => state.load);
  const setRemoteStatus = useRemoteStore((state) => state.setStatus);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [hostPrompt, setHostPrompt] = useState<HostKeyPrompt | null>(null);

  useEffect(() => {
    void loadProfiles();
    let active = true;
    let unlistenStatus: (() => void) | undefined;
    let unlistenHostKey: (() => void) | undefined;
    void remoteNative.onStatus(setRemoteStatus).then((unlisten) => {
      if (active) unlistenStatus = unlisten;
      else unlisten();
    });
    void remoteNative
      .onHostKey((prompt) => setHostPrompt(prompt))
      .then((unlisten) => {
        if (active) unlistenHostKey = unlisten;
        else unlisten();
      });
    return () => {
      active = false;
      unlistenStatus?.();
      unlistenHostKey?.();
    };
  }, [loadProfiles, setRemoteStatus]);

  const activeProfile = useMemo(
    () =>
      env.kind === "ssh"
        ? profiles.find((profile) => profile.id === env.profileId)
        : undefined,
    [env, profiles],
  );
  const activeStatus =
    env.kind === "ssh" ? statuses[env.profileId]?.status : undefined;

  const handleOpenChange = (open: boolean) => {
    if (IS_WINDOWS && open && distros.length === 0 && !loading) {
      void refreshDistros();
    }
  };

  const label =
    env.kind === "wsl"
      ? `WSL: ${env.distro}`
      : env.kind === "ssh"
        ? `SSH: ${activeProfile?.name ?? env.profileId}`
        : IS_WINDOWS
          ? "Windows"
          : "Local";

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-accent data-[state=open]:text-foreground"
            title="Workspace environment"
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
        <DropdownMenuContent align="start" className="min-w-52">
          <DropdownMenuItem onSelect={() => onSelect(LOCAL_WORKSPACE)}>
            {IS_WINDOWS ? "Windows Local" : "Local"}
          </DropdownMenuItem>
          {IS_WINDOWS ? (
            <>
              <DropdownMenuSeparator />
              {distros.length === 0 ? (
                <DropdownMenuItem disabled>
                  {loading
                    ? "Loading WSL distros..."
                    : error
                      ? "WSL unavailable"
                      : "No WSL distros found"}
                </DropdownMenuItem>
              ) : (
                distros.map((distro) => (
                  <DropdownMenuItem
                    key={distro.name}
                    onSelect={() =>
                      onSelect({ kind: "wsl", distro: distro.name })
                    }
                  >
                    WSL: {distro.name}
                  </DropdownMenuItem>
                ))
              )}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setRemoteOpen(true)}>
            Remote SSH
          </DropdownMenuItem>
          {env.kind === "ssh" ? (
            <DropdownMenuItem
              onSelect={() =>
                void remoteNative.reconnect(env.profileId).catch(() => {
                  setRemoteOpen(true);
                })
              }
            >
              Reconnect current SSH
            </DropdownMenuItem>
          ) : null}
          {IS_WINDOWS ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void refreshDistros()}>
                <HugeiconsIcon
                  icon={Refresh01Icon}
                  size={13}
                  strokeWidth={1.75}
                />
                Refresh WSL
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <RemoteSshDialog
        open={remoteOpen}
        onOpenChange={setRemoteOpen}
        onConnected={(profile) =>
          onSelect({ kind: "ssh", profileId: profile.id })
        }
      />
      <HostKeyDialog
        prompt={hostPrompt}
        onResolved={() => setHostPrompt(null)}
      />
    </>
  );
}
