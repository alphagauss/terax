/**
 * 本文件处理持久化 SSH 隧道的表单转换、校验和自动名称生成。
 * 空名称保持为空并在展示时派生，避免配置参数修改后留下过期名称。
 */

import type {
  SshTunnel,
  TunnelConfig,
  TunnelInfo,
  TunnelKind,
} from "./types";

export type TunnelForm = {
  name: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: string;
  targetHost: string;
  targetPort: string;
};

export type TunnelValidationIssue =
  | "bindHost"
  | "bindPort"
  | "targetHost"
  | "targetPort";

export function emptyTunnelForm(): TunnelForm {
  return {
    name: "",
    kind: "local",
    bindHost: "127.0.0.1",
    bindPort: "0",
    targetHost: "localhost",
    targetPort: "",
  };
}

export function tunnelFormFrom(info: TunnelInfo): TunnelForm {
  return {
    name: info.name,
    kind: info.kind,
    bindHost: info.bindHost,
    bindPort: String(info.requestedBindPort),
    targetHost: info.targetHost,
    targetPort: info.targetPort ? String(info.targetPort) : "",
  };
}

/** 将持久化隧道配置填入编辑表单。 */
export function tunnelFormFromSaved(tunnel: SshTunnel): TunnelForm {
  return {
    name: tunnel.name,
    kind: tunnel.kind,
    bindHost: tunnel.bindHost,
    bindPort: String(tunnel.bindPort),
    targetHost: tunnel.targetHost,
    targetPort: tunnel.targetPort ? String(tunnel.targetPort) : "",
  };
}

export function tunnelValidationIssue(
  form: TunnelForm,
): TunnelValidationIssue | null {
  if (/\s/.test(form.bindHost.trim())) return "bindHost";
  if (!isPort(form.bindPort, true)) return "bindPort";
  if (form.kind === "dynamic") return null;
  if (!form.targetHost.trim() || /\s/.test(form.targetHost.trim())) {
    return "targetHost";
  }
  if (!isPort(form.targetPort, false)) return "targetPort";
  return null;
}

export function tunnelConfigFromForm(
  form: TunnelForm,
  profileId: string,
  configId: string,
): TunnelConfig {
  return {
    configId,
    profileId,
    name: form.name.trim(),
    kind: form.kind,
    bindHost: form.bindHost.trim() || "127.0.0.1",
    bindPort: Number(form.bindPort),
    targetHost: form.kind === "dynamic" ? "" : form.targetHost.trim(),
    targetPort: form.kind === "dynamic" ? 0 : Number(form.targetPort),
  };
}

/** 将表单保存为 profile 内的持久化隧道定义。 */
export function savedTunnelFromForm(
  form: TunnelForm,
  id: string,
  enabled: boolean,
): SshTunnel {
  const config = tunnelConfigFromForm(form, "", id);
  return {
    id,
    enabled,
    name: config.name,
    kind: config.kind,
    bindHost: config.bindHost,
    bindPort: config.bindPort,
    targetHost: config.targetHost,
    targetPort: config.targetPort,
  };
}

/** 为未命名隧道生成与其转发语义一致的简洁展示名称。 */
export function tunnelDisplayName(
  tunnel: Pick<
    SshTunnel | TunnelInfo,
    "name" | "kind" | "bindHost" | "bindPort" | "targetHost" | "targetPort"
  >,
): string {
  if (tunnel.name.trim()) return tunnel.name;
  const type = tunnel.kind === "local" ? "L" : tunnel.kind === "remote" ? "R" : "D";
  const bind = `${tunnel.bindHost}:${tunnel.bindPort || "auto"}`;
  return tunnel.kind === "dynamic"
    ? `${type} ${bind}`
    : `${type} ${bind} → ${tunnel.targetHost}:${tunnel.targetPort}`;
}

function isPort(value: string, allowAutomatic: boolean): boolean {
  if (!value.trim()) return false;
  const port = Number(value);
  return (
    Number.isInteger(port) && port >= (allowAutomatic ? 0 : 1) && port <= 65535
  );
}
