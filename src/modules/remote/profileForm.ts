/**
 * 本文件负责 SSH profile 表单与持久化配置之间的转换和校验。
 * 隧道不在 profile 编辑表单中修改，但转换时必须保留已有的持久化隧道。
 */

import type { SshAuthMethod, SshProfile } from "@/modules/remote/types";
import { DEFAULT_SSH_GROUP_ID } from "@/modules/remote/groups";

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
  proxyMode: SshProfile["proxyMode"];
  proxySecret: string;
  proxySecretDirty: boolean;
  rememberProxySecret: boolean;
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
  | "reconnectAttempts";

export type LaunchSecretIssue = "secret" | "proxy";

/** 创建默认直连的 SSH 表单。 */
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
    proxyMode: "direct",
    proxySecret: "",
    proxySecretDirty: false,
    rememberProxySecret: true,
    reconnectEnabled: true,
    reconnectMaxAttempts: "2",
    rootPath: "~",
  };
}

/** 读取当前 SSH 配置，不推断旧代理格式。 */
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
    proxyMode: profile.proxyMode,
    proxySecret: "",
    proxySecretDirty: false,
    rememberProxySecret: true,
    reconnectEnabled: profile.reconnectEnabled,
    reconnectMaxAttempts: String(profile.reconnectMaxAttempts),
    rootPath: profile.rootPath ?? "~",
  };
}

/** 保存显式出口，只有自定义模式保留服务器代理地址。 */
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
    proxyMode: form.proxyMode,
    proxyUrl: form.proxyMode === "custom" ? form.proxyUrl.trim() || null : null,
    reconnectEnabled: form.reconnectEnabled,
    reconnectMaxAttempts: Number(form.reconnectMaxAttempts),
    rootPath: form.rootPath.trim() || "~",
    tunnels: [],
  };
}

/** 校验当前连接及其生效的自定义代理字段。 */
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
  if (form.proxyMode === "custom" && proxyUrlContainsPassword(form.proxyUrl))
    return "proxyPassword";
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

/** 只检查当前出口实际使用的临时凭据。 */
export function launchSecretIssue(
  form: Pick<
    SshProfileForm,
    | "secret"
    | "rememberSecret"
    | "proxySecret"
    | "rememberProxySecret"
    | "proxyMode"
  >,
): LaunchSecretIssue | null {
  if (form.secret && !form.rememberSecret) return "secret";
  if (
    form.proxyMode === "custom" &&
    form.proxySecret &&
    !form.rememberProxySecret
  )
    return "proxy";
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
