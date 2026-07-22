/**
 * 本文件验证持久化 SSH 隧道表单的校验、配置转换和自动名称规则。
 * 测试确保空名称不会阻止保存，并保留自动端口的配置意图。
 */

import { describe, expect, it } from "vitest";
import {
  emptyTunnelForm,
  savedTunnelFromForm,
  tunnelConfigFromForm,
  tunnelDisplayName,
  tunnelFormFrom,
  tunnelValidationIssue,
} from "./tunnelForm";

describe("tunnel form", () => {
  it("allows automatic bind ports and dynamic tunnels without a target", () => {
    const form = emptyTunnelForm();
    form.kind = "dynamic";
    form.targetHost = "";
    form.targetPort = "";

    expect(tunnelValidationIssue(form)).toBeNull();
    expect(tunnelConfigFromForm(form, "ssh-prod", "tunnel-socks")).toMatchObject({
      configId: "tunnel-socks",
      profileId: "ssh-prod",
      bindPort: 0,
      targetPort: 0,
    });
  });

  it("requires an endpoint for forwarding tunnels", () => {
    const form = emptyTunnelForm();
    form.targetPort = "";
    expect(tunnelValidationIssue(form)).toBe("targetPort");
    form.targetPort = "8080";
    expect(tunnelValidationIssue(form)).toBeNull();
    form.targetHost = "invalid host";
    expect(tunnelValidationIssue(form)).toBe("targetHost");
  });

  it("preserves automatic bind-port intent when editing an active tunnel", () => {
    const form = tunnelFormFrom({
      id: 7,
      configId: "tunnel-app",
      profileId: "ssh-prod",
      name: "App",
      kind: "local",
      status: "active",
      bindHost: "127.0.0.1",
      bindPort: 49152,
      requestedBindPort: 0,
      targetHost: "app.internal",
      targetPort: 8080,
      bytes: 0,
    });

    expect(form.bindPort).toBe("0");
    expect(tunnelConfigFromForm(form, "ssh-prod", "tunnel-app").bindPort).toBe(0);
  });

  it("keeps an empty name and derives a concise display label", () => {
    const form = emptyTunnelForm();
    form.name = "";
    form.bindPort = "3000";
    form.targetHost = "db";
    form.targetPort = "5432";

    const tunnel = savedTunnelFromForm(form, "tunnel-db", true);
    expect(tunnel.name).toBe("");
    expect(tunnelDisplayName(tunnel)).toBe("L 127.0.0.1:3000 → db:5432");
  });
});
