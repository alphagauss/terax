/**
 * 本文件定义 SSH profile、连接和隧道在前端与 Tauri 命令之间共享的数据类型。
 * 持久化隧道使用稳定配置 ID，运行时隧道 ID 只用于当前进程的资源控制。
 */

export type SshAuthMethod = "password" | "private_key" | "agent";

export type SshProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  identityFile?: string | null;
  proxyUrl?: string | null;
  keepaliveSeconds: number;
  reconnectEnabled: boolean;
  reconnectMaxAttempts: number;
  rootPath?: string | null;
  tunnels: SshTunnel[];
};

export type SshTunnel = {
  id: string;
  enabled: boolean;
  name: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
};

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export type ConnectionInfo = {
  profileId: string;
  status: ConnectionStatus;
  home?: string | null;
  message?: string | null;
};

export type HostKeyPrompt = {
  requestId: string;
  profileId: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  changed: boolean;
};

export type ImportedHost = {
  alias: string;
  hostname: string;
  user: string;
  port: number;
  identityFile: string;
};

export type TunnelKind = "local" | "remote" | "dynamic";
export type TunnelStatus = "active" | "failed" | "closed";

export type TunnelConfig = {
  configId: string;
  profileId: string;
  name: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
};

export type TunnelInfo = {
  id: number;
  configId: string;
  profileId: string;
  name: string;
  kind: TunnelKind;
  status: TunnelStatus;
  bindHost: string;
  bindPort: number;
  requestedBindPort: number;
  targetHost: string;
  targetPort: number;
  bytes: number;
  error?: string | null;
};

export type TunnelEventKind = "started" | "updated" | "stopped" | "failed";

export type TunnelEvent = {
  kind: TunnelEventKind;
  profileId: string;
  tunnel?: TunnelInfo | null;
  message?: string | null;
};
