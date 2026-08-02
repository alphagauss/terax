/**
 * 本文件初始化当前应用进程绑定的 Local、WSL 或 SSH 环境。
 * SSH 只投影 Rust Runtime 的权威快照；连接、重连和 epoch 均不在前端推断。
 */

import { native } from "@/modules/ai/lib/native";
import {
  connectedRuntimeHome,
  remoteNative,
  useRemoteRuntimeStore,
  useRemoteStore,
  waitForRuntimeSettlement,
  type HostKeyPrompt,
  type RemoteRuntimeSnapshot,
  type SshCredentialInput,
  type SshProfile,
} from "@/modules/remote";
import { currentWorkspaceEnv, getWslHome } from "@/modules/workspace";
import { homeDir } from "@tauri-apps/api/path";
import { useCallback, useEffect, useRef, useState } from "react";

/** 从当前 profile 和系统密钥链构造一次完整 SSH 连接。 */
async function connectSshProfile(
  profile: SshProfile,
  credentials?: SshCredentialInput,
): Promise<RemoteRuntimeSnapshot> {
  const [storedSecret, storedProxySecret] = credentials
    ? [credentials.secret, credentials.proxySecret]
    : await Promise.all([
        profile.authMethod === "agent"
          ? null
          : remoteNative.getSecret(profile.id),
        profile.proxyUrl?.trim()
          ? remoteNative.getProxySecret(profile.id)
          : null,
      ]);
  return remoteNative.connectRuntime(
    profile,
    storedSecret ?? "",
    storedProxySecret ?? "",
  );
}

/**
 * 管理当前进程绑定环境的就绪入口。
 *
 * SSH 连接中的调用等待同一 Runtime 状态收敛；同一前端连接任务只执行一次，
 * 显式重连在没有在途任务时执行破坏式 reset。
 */
export function useWorkspaceEnvironment() {
  const env = currentWorkspaceEnv();
  const runtimeSnapshot = useRemoteRuntimeStore((state) => state.snapshot);
  const applyRuntimeSnapshot = useRemoteRuntimeStore(
    (state) => state.applySnapshot,
  );
  const [nonSshHome, setNonSshHome] = useState<string | null>(null);
  const nonSshHomeRef = useRef<string | null>(null);
  const [localLaunchCwd, setLocalLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);
  const [remoteBridgeError, setRemoteBridgeError] = useState<string | null>(
    null,
  );
  const [environmentActionError, setEnvironmentActionError] = useState<
    string | null
  >(null);
  const [remoteEventsReady, setRemoteEventsReady] = useState(
    () => env.kind !== "ssh",
  );
  const [hostPrompt, setHostPrompt] = useState<HostKeyPrompt | null>(null);
  const connectionTaskRef = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    if (env.kind !== "ssh") return;
    let active = true;
    let unlistenRuntime: (() => void) | undefined;
    let unlistenHostKey: (() => void) | undefined;
    setRemoteEventsReady(false);
    setRemoteBridgeError(null);
    void (async () => {
      try {
        unlistenRuntime = await remoteNative.onRuntime(applyRuntimeSnapshot);
        if (!active) {
          unlistenRuntime();
          return;
        }
        unlistenHostKey = await remoteNative.onHostKey(setHostPrompt);
        if (!active) {
          unlistenHostKey();
          return;
        }
        const snapshot = await remoteNative.runtimeSnapshot();
        if (!active) return;
        applyRuntimeSnapshot(snapshot);
        setRemoteEventsReady(true);
      } catch (error) {
        unlistenRuntime?.();
        unlistenHostKey?.();
        unlistenRuntime = undefined;
        unlistenHostKey = undefined;
        if (active) {
          setRemoteBridgeError(`SSH event bridge failed: ${String(error)}`);
          setRemoteEventsReady(false);
        }
      }
    })();
    return () => {
      active = false;
      unlistenRuntime?.();
      unlistenHostKey?.();
    };
  }, [applyRuntimeSnapshot, env.kind]);

  useEffect(() => {
    if (
      env.kind === "ssh" &&
      runtimeSnapshot.phase === "connected" &&
      runtimeSnapshot.profileId === env.profileId
    ) {
      setEnvironmentActionError(null);
    }
  }, [env, runtimeSnapshot]);

  useEffect(() => {
    if (
      env.kind === "ssh" &&
      runtimeSnapshot.phase !== "connecting" &&
      runtimeSnapshot.phase !== "reconnecting"
    ) {
      setHostPrompt(null);
    }
  }, [env.kind, runtimeSnapshot.phase]);

  useEffect(() => {
    if (env.kind !== "local") {
      setLocalLaunchCwd(null);
      setLaunchCwdResolved(true);
      return;
    }
    native
      .workspaceCurrentDir()
      .then(setLocalLaunchCwd)
      .catch(() => setLocalLaunchCwd(null))
      .finally(() => setLaunchCwdResolved(true));
  }, [env.kind]);

  const connectWorkspace = useCallback(
    async (
      credentials?: SshCredentialInput,
      force = false,
    ): Promise<string | null> => {
      if (env.kind !== "ssh") return null;
      // 没有 Runtime 事件就无法保证断线状态收敛，禁止建立不可观测的连接。
      if (!remoteEventsReady) return null;
      const current = useRemoteRuntimeStore.getState().snapshot;
      if (!force) {
        const connectedHome = connectedRuntimeHome(current);
        if (connectedHome) return connectedHome;
        if (
          current.phase === "connecting" ||
          current.phase === "reconnecting"
        ) {
          return waitForRuntimeSettlement();
        }
      }
      if (connectionTaskRef.current) return connectionTaskRef.current;

      setEnvironmentActionError(null);
      setHostPrompt(null);
      const task = (async () => {
        try {
          const profiles = await useRemoteStore.getState().load();
          const profile = profiles.find((item) => item.id === env.profileId);
          if (!profile) {
            throw new Error(`SSH profile not found: ${env.profileId}`);
          }
          const snapshot = await connectSshProfile(profile, credentials);
          applyRuntimeSnapshot(snapshot);
          setEnvironmentActionError(null);
          const readyHome = connectedRuntimeHome(snapshot);
          if (readyHome) {
            try {
              await native.workspaceAuthorize(readyHome);
            } catch {
              // 远端授权仅记录 Workspace root，具体失败由对应面板呈现。
            }
          }
          return readyHome;
        } catch (error) {
          const snapshot = await remoteNative
            .runtimeSnapshot()
            .catch(() => null);
          if (snapshot) applyRuntimeSnapshot(snapshot);
          setEnvironmentActionError(
            snapshot?.phase === "disconnected" ? null : String(error),
          );
          return null;
        }
      })();
      connectionTaskRef.current = task;
      try {
        return await task;
      } finally {
        if (connectionTaskRef.current === task) {
          connectionTaskRef.current = null;
        }
      }
    },
    [applyRuntimeSnapshot, env, remoteEventsReady],
  );

  const ensureWorkspaceReady = useCallback(async (): Promise<string | null> => {
    if (env.kind === "ssh") return connectWorkspace();
    if (nonSshHomeRef.current) return nonSshHomeRef.current;
    try {
      const nextHome =
        env.kind === "wsl"
          ? await getWslHome(env.distro)
          : (await homeDir()).replace(/\\/g, "/");
      nonSshHomeRef.current = nextHome;
      setNonSshHome(nextHome);
      setEnvironmentActionError(null);
      try {
        await native.workspaceAuthorize(nextHome);
      } catch {
        // 不可用 root 的具体错误由对应面板呈现。
      }
      return nextHome;
    } catch (error) {
      setEnvironmentActionError(String(error));
      return null;
    }
  }, [connectWorkspace, env]);

  const reconnectWorkspace = useCallback(
    (credentials?: SshCredentialInput) =>
      env.kind === "ssh"
        ? connectWorkspace(credentials, true)
        : ensureWorkspaceReady(),
    [connectWorkspace, ensureWorkspaceReady, env.kind],
  );

  // 只有 connected 快照中的 Home 可以作为文件、PTY 或启动恢复的就绪凭据。
  const remoteHome = connectedRuntimeHome(runtimeSnapshot);
  const home = env.kind === "ssh" ? remoteHome : nonSshHome;
  const launchCwd =
    env.kind === "local"
      ? localLaunchCwd
      : env.kind === "ssh"
        ? remoteHome
        : nonSshHome;
  const runtimeError =
    env.kind === "ssh" && runtimeSnapshot.phase === "disconnected"
      ? runtimeSnapshot.reason
      : null;

  return {
    home,
    launchCwd,
    launchCwdResolved,
    environmentError:
      remoteBridgeError ?? environmentActionError ?? runtimeError,
    remoteEventsReady,
    hostPrompt,
    clearHostPrompt: () => setHostPrompt(null),
    ensureWorkspaceReady,
    reconnectWorkspace,
  };
}
