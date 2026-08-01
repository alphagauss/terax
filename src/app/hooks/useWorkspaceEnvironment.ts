/**
 * 本文件初始化当前应用进程绑定的 Local、WSL 或 SSH 环境。
 * SSH 事件监听先于自动连接建立，远端密钥不会跨进程或写入普通配置。
 */

import { native } from "@/modules/ai/lib/native";
import {
  remoteNative,
  useRemoteStore,
  type ConnectionStatus,
  type HostKeyPrompt,
} from "@/modules/remote";
import {
  currentWorkspaceEnv,
  getSshHome,
  getWslHome,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { homeDir } from "@tauri-apps/api/path";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 解析当前环境的 Home，并在 SSH 未连接时建立连接。
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
 * 管理当前应用进程绑定环境的按需就绪状态。
 *
 * SSH 事件监听先于页面恢复建立；并发请求复用同一次连接，原生重连期间不替换 transport。
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
  const resolvedHomeRef = useRef<string | null>(null);
  const initializationRef = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    if (currentWorkspaceEnv().kind !== "ssh") return;
    let active = true;
    let unlistenStatus: (() => void) | undefined;
    let unlistenHostKey: (() => void) | undefined;
    void (async () => {
      try {
        const status = await remoteNative.onStatus((info) => {
          useRemoteStore.getState().setStatus(info);
          const env = currentWorkspaceEnv();
          if (
            env.kind !== "ssh" ||
            info.profileId !== env.profileId ||
            info.status !== "connected"
          ) {
            return;
          }
          setEnvironmentError(null);
        });
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

  const ensureWorkspaceReady = useCallback(async (): Promise<string | null> => {
    const env = currentWorkspaceEnv();
    const reusableHome = resolvedHomeRef.current;
    const sshStatus =
      env.kind === "ssh"
        ? useRemoteStore.getState().statuses[env.profileId]?.status
        : undefined;
    if (canReuseWorkspaceHome(env, reusableHome, sshStatus)) {
      setEnvironmentError(null);
      return reusableHome;
    }
    if (initializationRef.current) return initializationRef.current;
    if (sshStatus === "connecting" || sshStatus === "reconnecting") {
      // 原生自动重连拥有自己的串行与退避流程，此时不并发发起替换连接。
      return null;
    }

    const task = (async () => {
      try {
        const nextHome = await resolveEnvHome(env);
        resolvedHomeRef.current = nextHome;
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
    })();
    initializationRef.current = task;
    try {
      return await task;
    } finally {
      if (initializationRef.current === task) initializationRef.current = null;
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
    ensureWorkspaceReady,
  };
}

/**
 * 判断已解析的 Home 能否作为当前环境的就绪凭据复用。
 *
 * SSH 的路径缓存不代表连接仍存活，只有运行时状态为 connected 时才能复用。
 */
export function canReuseWorkspaceHome(
  env: WorkspaceEnv,
  home: string | null,
  sshStatus?: ConnectionStatus,
): home is string {
  return Boolean(home) && (env.kind !== "ssh" || sshStatus === "connected");
}
