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
export type TunnelStatus = "starting" | "active" | "failed" | "closed";

export type TunnelConfig = {
  profileId: string;
  name: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
};

export type TunnelInfo = TunnelConfig & {
  id: number;
  status: TunnelStatus;
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
