import { native } from "@/modules/ai/lib/native";
import {
  remoteNative,
  useRemoteStore,
  type HostKeyPrompt,
} from "@/modules/remote";
import {
  currentWorkspaceEnv,
  getSshHome,
  getWslHome,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { homeDir } from "@tauri-apps/api/path";
import { useCallback, useEffect, useState } from "react";

async function resolveEnvHome(env: WorkspaceEnv): Promise<string> {
  if (env.kind === "wsl") return getWslHome(env.distro);
  if (env.kind === "ssh") {
    const profiles = await useRemoteStore.getState().load();
    const profile = profiles.find((item) => item.id === env.profileId);
    if (!profile) throw new Error(`SSH profile not found: ${env.profileId}`);
    const status = await remoteNative.status(env.profileId).catch(() => null);
    if (status?.status !== "connected") {
      const [secret, proxySecret] = await Promise.all([
        remoteNative.getSecret(env.profileId),
        remoteNative.getProxySecret(env.profileId),
      ]);
      const connected = await remoteNative.connect(
        profile,
        secret ?? "",
        proxySecret ?? "",
      );
      useRemoteStore.getState().setStatus(connected);
    }
    return getSshHome(env.profileId);
  }
  return (await homeDir()).replace(/\\/g, "/");
}

/** Resolves and authorizes the environment bound to this application process. */
export function useWorkspaceEnvironment() {
  const [home, setHome] = useState<string | null>(null);
  const [launchCwd, setLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [remoteEventsReady, setRemoteEventsReady] = useState(
    () => currentWorkspaceEnv().kind !== "ssh",
  );
  const [hostPrompt, setHostPrompt] = useState<HostKeyPrompt | null>(null);

  useEffect(() => {
    if (currentWorkspaceEnv().kind !== "ssh") return;
    let active = true;
    let unlistenStatus: (() => void) | undefined;
    let unlistenHostKey: (() => void) | undefined;
    void (async () => {
      try {
        const status = await remoteNative.onStatus((info) =>
          useRemoteStore.getState().setStatus(info),
        );
        if (!active) {
          status();
          return;
        }
        unlistenStatus = status;
        const hostKey = await remoteNative.onHostKey(setHostPrompt);
        if (!active) {
          hostKey();
          return;
        }
        unlistenHostKey = hostKey;
        setRemoteEventsReady(true);
      } catch (error) {
        unlistenStatus?.();
        unlistenStatus = undefined;
        if (active) {
          setEnvironmentError(`SSH event bridge failed: ${String(error)}`);
        }
      }
    })();
    return () => {
      active = false;
      unlistenStatus?.();
      unlistenHostKey?.();
    };
  }, []);

  useEffect(() => {
    if (currentWorkspaceEnv().kind !== "local") {
      setLaunchCwd(null);
      setLaunchCwdResolved(true);
      return;
    }
    native
      .workspaceCurrentDir()
      .then(setLaunchCwd)
      .catch(() => setLaunchCwd(null))
      .finally(() => setLaunchCwdResolved(true));
  }, []);

  const initializeWorkspaceEnv = useCallback(async (): Promise<string | null> => {
    const env = currentWorkspaceEnv();
    try {
      const nextHome = await resolveEnvHome(env);
      setHome(nextHome);
      if (env.kind !== "local") setLaunchCwd(nextHome);
      setEnvironmentError(null);
      try {
        await native.workspaceAuthorize(nextHome);
      } catch {
        // Remote paths and unavailable roots surface their own panel errors.
      }
      return nextHome;
    } catch (error) {
      setEnvironmentError(String(error));
      return null;
    }
  }, []);

  return {
    home,
    launchCwd,
    launchCwdResolved,
    environmentError,
    remoteEventsReady,
    hostPrompt,
    clearHostPrompt: () => setHostPrompt(null),
    initializeWorkspaceEnv,
  };
}
