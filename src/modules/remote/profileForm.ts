/**
 * 本文件负责 SSH profile 表单与持久化配置之间的转换和校验。
 * 隧道不在 profile 编辑表单中修改，但转换时必须保留已有的持久化隧道。
 */

import type { SshAuthMethod, SshProfile } from "./types";
import { DEFAULT_SSH_GROUP_ID } from "./groups";

export type SshProfileForm = {
  id: string;
  groupId: string;
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: SshAuthMethod;
  identityFile: string;
  secret: string;
  secretDirty: boolean;
  rememberSecret: boolean;
  proxyUrl: string;
  proxySecret: string;
  proxySecretDirty: boolean;
  rememberProxySecret: boolean;
  keepaliveSeconds: string;
  reconnectEnabled: boolean;
  reconnectMaxAttempts: string;
  rootPath: string;
};

export type ProfileValidationIssue =
  | "host"
  | "port"
  | "username"
  | "identityFile"
  | "proxyPassword"
  | "keepalive"
  | "reconnectAttempts";

export type LaunchSecretIssue = "secret" | "proxy";

export function emptySshProfileForm(id: string): SshProfileForm {
  return {
    id,
    groupId: DEFAULT_SSH_GROUP_ID,
    name: "",
    host: "",
    port: "22",
    username: "",
    authMethod: "password",
    identityFile: "",
    secret: "",
    secretDirty: false,
    rememberSecret: true,
    proxyUrl: "",
    proxySecret: "",
    proxySecretDirty: false,
    rememberProxySecret: true,
    keepaliveSeconds: "30",
    reconnectEnabled: true,
    reconnectMaxAttempts: "2",
    rootPath: "~",
  };
}

export function sshProfileFormFrom(profile: SshProfile): SshProfileForm {
  return {
    id: profile.id,
    groupId: profile.groupId,
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    authMethod: profile.authMethod,
    identityFile: profile.identityFile ?? "",
    secret: "",
    secretDirty: false,
    rememberSecret: true,
    proxyUrl: profile.proxyUrl ?? "",
    proxySecret: "",
    proxySecretDirty: false,
    rememberProxySecret: true,
    keepaliveSeconds: String(profile.keepaliveSeconds),
    reconnectEnabled: profile.reconnectEnabled,
    reconnectMaxAttempts: String(profile.reconnectMaxAttempts),
    rootPath: profile.rootPath ?? "~",
  };
}

export function sshProfileFromForm(form: SshProfileForm): SshProfile {
  const host = form.host.trim();
  const username = form.username.trim();
  return {
    id: form.id,
    groupId: form.groupId,
    name: form.name.trim() || `${username}@${host}`,
    host,
    port: Number(form.port),
    username,
    authMethod: form.authMethod,
    identityFile: form.identityFile.trim() || null,
    proxyUrl: form.proxyUrl.trim() || null,
    keepaliveSeconds: Number(form.keepaliveSeconds),
    reconnectEnabled: form.reconnectEnabled,
    reconnectMaxAttempts: Number(form.reconnectMaxAttempts),
    rootPath: form.rootPath.trim() || "~",
    tunnels: [],
  };
}

export function profileValidationIssue(
  form: SshProfileForm,
): ProfileValidationIssue | null {
  if (!form.host.trim() || /\s/.test(form.host.trim())) {
    return "host";
  }
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "port";
  if (!form.username.trim()) return "username";
  if (form.authMethod === "private_key" && !form.identityFile.trim()) {
    return "identityFile";
  }
  if (proxyUrlContainsPassword(form.proxyUrl)) return "proxyPassword";
  const keepalive = Number(form.keepaliveSeconds);
  if (
    !form.keepaliveSeconds.trim() ||
    !Number.isSafeInteger(keepalive) ||
    keepalive < 0
  ) {
    return "keepalive";
  }
  const reconnectAttempts = Number(form.reconnectMaxAttempts);
  if (
    !Number.isInteger(reconnectAttempts) ||
    reconnectAttempts < 1 ||
    reconnectAttempts > 20
  ) {
    return "reconnectAttempts";
  }
  return null;
}

export type CredentialMutation =
  | { kind: "keep" }
  | { kind: "delete" }
  | { kind: "set"; value: string };

export function credentialMutation({
  value,
  dirty,
  remember,
  applicable,
}: {
  value: string;
  dirty: boolean;
  remember: boolean;
  applicable: boolean;
}): CredentialMutation {
  if (!applicable || !remember) return { kind: "delete" };
  if (!dirty) return { kind: "keep" };
  return value ? { kind: "set", value } : { kind: "delete" };
}

export async function applyCredentialMutation(
  mutation: CredentialMutation,
  set: (value: string) => Promise<void>,
  remove: () => Promise<void>,
) {
  if (mutation.kind === "set") {
    await set(mutation.value);
  } else if (mutation.kind === "delete") {
    await remove();
  }
}

export function launchSecretIssue(
  form: Pick<
    SshProfileForm,
    "secret" | "rememberSecret" | "proxySecret" | "rememberProxySecret"
  >,
): LaunchSecretIssue | null {
  if (form.secret && !form.rememberSecret) return "secret";
  if (form.proxySecret && !form.rememberProxySecret) return "proxy";
  return null;
}

function proxyUrlContainsPassword(value: string): boolean {
  const authority = value.split("://", 2)[1]?.split("/", 1)[0] ?? "";
  const userInfo = authority.includes("@")
    ? authority.slice(0, authority.lastIndexOf("@"))
    : "";
  const separator = userInfo.indexOf(":");
  return separator >= 0 && userInfo.slice(separator + 1).length > 0;
}
