/**
 * 本文件定义 SSH profile、连接、文件后端、健康、流量和隧道的跨进程数据类型。
 * 持久化隧道使用稳定配置 ID，运行时隧道 ID 只用于当前进程的资源控制。
 */

export type SshAuthMethod = "password" | "private_key" | "agent";

export type SshGroup = {
  id: string;
  name: string;
};

export type SshProfile = {
  id: string;
  groupId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  identityFile?: string | null;
  proxyUrl?: string | null;
  reconnectEnabled: boolean;
  reconnectMaxAttempts: number;
  rootPath?: string | null;
  tunnels: SshTunnel[];
};

export type SshCredentialInput = {
  secret: string | null;
  proxySecret: string | null;
};

export type RemoteForegroundIntent =
  | { kind: "terminal"; cwd: string | null; blocks: boolean }
  | { kind: "explorer" }
  | { kind: "none" };

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

export type RemoteRuntimeSnapshot =
  | { phase: "idle"; version: number }
  | {
      phase: "connecting";
      version: number;
      profileId: string;
    }
  | {
      phase: "reconnecting";
      version: number;
      profileId: string;
    }
  | {
      phase: "connected";
      version: number;
      epoch: number;
      profileId: string;
      home: string;
    }
  | {
      phase: "disconnected";
      version: number;
      profileId: string;
      reason: string;
    };

export type SshTrafficSnapshot = {
  uploadedBytes: number;
  downloadedBytes: number;
};

export type SshHealthSnapshot = {
  epoch: number | null;
  rttMs: number | null;
  sampledAt: number | null;
};

export type SshFileBackendSnapshot = {
  epoch: number | null;
  capability: "detecting" | "available" | "unavailable";
  activeBackend: "sftp" | "python";
  pythonVersion: string | null;
  enabled: boolean;
  fallback: boolean;
  latencyEligible: boolean;
  rttThresholdMs: number;
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
