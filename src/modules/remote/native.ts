/**
 * 本文件封装 SSH 连接、终端和隧道相关的 Tauri IPC。
 * 文件传输统一由 transfers 模块管理，这里不暴露平行上传或下载入口。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ConnectionInfo,
  HostKeyPrompt,
  ImportedHost,
  SshProfile,
  TunnelConfig,
  TunnelEvent,
  TunnelInfo,
} from "./types";

export const SSH_SECRET_SERVICE = "terax-ssh";
const proxySecretAccount = (profileId: string) => `${profileId}:proxy`;

export const remoteNative = {
  connect: (
    profile: SshProfile,
    secret?: string | null,
    proxySecret?: string | null,
  ) =>
    invoke<ConnectionInfo>("ssh_connect", {
      request: {
        profile,
        secret: secret || null,
        proxySecret: proxySecret || null,
      },
    }),
  disconnect: (profileId: string) =>
    invoke<void>("ssh_disconnect", { profileId }),
  reconnect: (profileId: string) =>
    invoke<ConnectionInfo>("ssh_reconnect", { profileId }),
  status: (profileId: string) =>
    invoke<ConnectionInfo>("ssh_connection_status", { profileId }),
  home: (profileId: string) => invoke<string>("ssh_home", { profileId }),
  confirmHostKey: (requestId: string, accepted: boolean, remember: boolean) =>
    invoke<void>("ssh_confirm_host_key", {
      requestId,
      accepted,
      remember,
    }),
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
  onStatus: (handler: (info: ConnectionInfo) => void): Promise<UnlistenFn> =>
    listen<ConnectionInfo>("terax://ssh-status", (event) =>
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
