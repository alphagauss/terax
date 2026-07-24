/**
 * 本文件初始化当前应用进程绑定的 Local、WSL 或 SSH 环境。
 * SSH 事件监听先于自动连接建立，远端密钥不会跨进程或写入普通配置。
 */

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

/**
 * 解析当前环境的初始 root。
 *
 * SSH 分支复用配置 store 已获取的状态，并仅按认证和代理方式读取必要密钥。
 */
async function resolveEnvHome(env: WorkspaceEnv): Promise<string> {
  if (env.kind === "wsl") return getWslHome(env.distro);
  if (env.kind === "ssh") {
    const remoteStore = useRemoteStore.getState();
    const profiles = await remoteStore.load();
    const profile = profiles.find((item) => item.id === env.profileId);
    if (!profile) throw new Error(`SSH profile not found: ${env.profileId}`);
    const status = useRemoteStore.getState().statuses[env.profileId];
    if (status?.status === "connected" && status.home) return status.home;
    if (status?.status !== "connected") {
      const [secret, proxySecret] = await Promise.all([
        profile.authMethod === "agent"
          ? null
          : remoteNative.getSecret(env.profileId),
        profile.proxyUrl?.trim()
          ? remoteNative.getProxySecret(env.profileId)
          : null,
      ]);
      const connected = await remoteNative.connect(
        profile,
        secret ?? "",
        proxySecret ?? "",
      );
      useRemoteStore.getState().setStatus(connected);
      if (!connected.home) {
        throw new Error("SSH connected without a resolved workspace home");
      }
      return connected.home;
    }
    return getSshHome(env.profileId);
  }
  return (await homeDir()).replace(/\\/g, "/");
}

/**
 * 解析并授权当前应用进程绑定的工作区环境。
 *
 * SSH 认证所需事件监听会先行建立，初始化成功后返回终端与 Explorer 共用的 root。
 */
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

  const initializeWorkspaceEnv = useCallback(async (): Promise<
    string | null
  > => {
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
