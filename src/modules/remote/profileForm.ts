import type { SshAuthMethod, SshProfile } from "./types";

export type SshProfileForm = {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: SshAuthMethod;
  identityFile: string;
  secret: string;
  rememberSecret: boolean;
  proxyUrl: string;
  proxySecret: string;
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
  | "proxyPassword";

export type LaunchSecretIssue = "secret" | "proxy";

export function emptySshProfileForm(id: string): SshProfileForm {
  return {
    id,
    name: "",
    host: "",
    port: "22",
    username: "",
    authMethod: "password",
    identityFile: "",
    secret: "",
    rememberSecret: true,
    proxyUrl: "",
    proxySecret: "",
    rememberProxySecret: true,
    keepaliveSeconds: "30",
    reconnectEnabled: true,
    reconnectMaxAttempts: "5",
    rootPath: "~",
  };
}

export function sshProfileFormFrom(profile: SshProfile): SshProfileForm {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    authMethod: profile.authMethod,
    identityFile: profile.identityFile ?? "",
    secret: "",
    rememberSecret: true,
    proxyUrl: profile.proxyUrl ?? "",
    proxySecret: "",
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
    name: form.name.trim() || `${username}@${host}`,
    host,
    port: Number(form.port) || 22,
    username,
    authMethod: form.authMethod,
    identityFile: form.identityFile.trim() || null,
    proxyUrl: form.proxyUrl.trim() || null,
    keepaliveSeconds: Math.max(0, Number(form.keepaliveSeconds) || 0),
    reconnectEnabled: form.reconnectEnabled,
    reconnectMaxAttempts: Math.max(1, Number(form.reconnectMaxAttempts) || 5),
    rootPath: form.rootPath.trim() || "~",
  };
}

export function profileValidationIssue(
  form: SshProfileForm,
): ProfileValidationIssue | null {
  if (!form.host.trim()) return "host";
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "port";
  if (!form.username.trim()) return "username";
  if (form.authMethod === "private_key" && !form.identityFile.trim()) {
    return "identityFile";
  }
  if (proxyUrlContainsPassword(form.proxyUrl)) return "proxyPassword";
  return null;
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
