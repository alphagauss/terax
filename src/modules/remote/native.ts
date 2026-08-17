/**
 * 本文件封装 SSH 连接、transport 流量、终端和隧道相关的 Tauri IPC。
 * 文件传输统一由 transfers 模块管理，这里不暴露平行上传或下载入口。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  HostKeyPrompt,
  ImportedHost,
  RemoteForegroundIntent,
  RemoteRuntimeSnapshot,
  SshCredentialInput,
  SshTrafficSnapshot,
  TunnelConfig,
  TunnelEvent,
  TunnelInfo,
} from "./types";

export const SSH_SECRET_SERVICE = "terax-ssh";
const proxySecretAccount = (profileId: string) => `${profileId}:proxy`;

/** SSH Runtime、隧道、主机密钥与凭据的原生调用边界。 */
export const remoteNative = {
  connectRuntime: (profileId: string, credentials?: SshCredentialInput) =>
    invoke<RemoteRuntimeSnapshot>("ssh_runtime_connect", {
      profileId,
      credentials: credentials ?? null,
    }),
  disconnectRuntime: () => invoke<void>("ssh_runtime_disconnect"),
  runtimeSnapshot: () => invoke<RemoteRuntimeSnapshot>("ssh_runtime_snapshot"),
  trafficSnapshot: () => invoke<SshTrafficSnapshot>("ssh_traffic_snapshot"),
  wakeRuntime: () => invoke<RemoteRuntimeSnapshot>("ssh_runtime_wake"),
  setForeground: (intent: RemoteForegroundIntent) =>
    invoke<void>("ssh_runtime_set_foreground", { intent }),
  confirmHostKey: (requestId: string, accepted: boolean, remember: boolean) =>
    invoke<void>("ssh_confirm_host_key", {
      requestId,
      accepted,
      remember,
    }),
  pendingHostKey: () => invoke<HostKeyPrompt | null>("ssh_pending_host_key"),
  importConfig: () => invoke<ImportedHost[]>("ssh_import_config"),
  listTunnels: (profileId: string) =>
    invoke<TunnelInfo[]>("ssh_tunnel_list", {
      profileId,
    }),
  startTunnel: (config: TunnelConfig) =>
    invoke<TunnelInfo>("ssh_tunnel_start", { config }),
  updateTunnel: (id: number, config: TunnelConfig) =>
    invoke<TunnelInfo>("ssh_tunnel_update", { id, config }),
  stopTunnel: (id: number) => invoke<void>("ssh_tunnel_stop", { id }),
  getSecret: (profileId: string) =>
    invoke<string | null>("secrets_get", {
      service: SSH_SECRET_SERVICE,
      account: profileId,
    }),
  setSecret: (profileId: string, secret: string) =>
    invoke<void>("secrets_set", {
      service: SSH_SECRET_SERVICE,
      account: profileId,
      password: secret,
    }),
  getProxySecret: (profileId: string) =>
    invoke<string | null>("secrets_get", {
      service: SSH_SECRET_SERVICE,
      account: proxySecretAccount(profileId),
    }),
  setProxySecret: (profileId: string, secret: string) =>
    invoke<void>("secrets_set", {
      service: SSH_SECRET_SERVICE,
      account: proxySecretAccount(profileId),
      password: secret,
    }),
  deleteProxySecret: (profileId: string) =>
    invoke<void>("secrets_delete", {
      service: SSH_SECRET_SERVICE,
      account: proxySecretAccount(profileId),
    }),
  deleteAuthSecret: (profileId: string) =>
    invoke<void>("secrets_delete", {
      service: SSH_SECRET_SERVICE,
      account: profileId,
    }),
  deleteSecrets: async (profileId: string) => {
    await Promise.all([
      remoteNative.deleteAuthSecret(profileId),
      remoteNative.deleteProxySecret(profileId),
    ]);
  },
  onRuntime: (
    handler: (info: RemoteRuntimeSnapshot) => void,
  ): Promise<UnlistenFn> =>
    listen<RemoteRuntimeSnapshot>("terax://ssh-runtime", (event) =>
      handler(event.payload),
    ),
  onTunnel: (handler: (event: TunnelEvent) => void): Promise<UnlistenFn> =>
    listen<TunnelEvent>("terax://ssh-tunnel", (event) =>
      handler(event.payload),
    ),
  onHostKey: (handler: (prompt: HostKeyPrompt) => void): Promise<UnlistenFn> =>
    listen<HostKeyPrompt>("terax://ssh-host-key", (event) =>
      handler(event.payload),
    ),
};
