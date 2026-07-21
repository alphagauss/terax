import type { TunnelConfig, TunnelInfo, TunnelKind } from "./types";

export type TunnelForm = {
  name: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: string;
  targetHost: string;
  targetPort: string;
};

export type TunnelValidationIssue =
  | "name"
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

export function tunnelValidationIssue(
  form: TunnelForm,
): TunnelValidationIssue | null {
  if (!form.name.trim()) return "name";
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
): TunnelConfig {
  return {
    profileId,
    name: form.name.trim(),
    kind: form.kind,
    bindHost: form.bindHost.trim() || "127.0.0.1",
    bindPort: Number(form.bindPort),
    targetHost: form.kind === "dynamic" ? "" : form.targetHost.trim(),
    targetPort: form.kind === "dynamic" ? 0 : Number(form.targetPort),
  };
}

function isPort(value: string, allowAutomatic: boolean): boolean {
  if (!value.trim()) return false;
  const port = Number(value);
  return (
    Number.isInteger(port) && port >= (allowAutomatic ? 0 : 1) && port <= 65535
  );
}
