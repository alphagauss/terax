import { describe, expect, it } from "vitest";
import {
  emptyTunnelForm,
  tunnelConfigFromForm,
  tunnelFormFrom,
  tunnelValidationIssue,
} from "./tunnelForm";

describe("tunnel form", () => {
  it("allows automatic bind ports and dynamic tunnels without a target", () => {
    const form = emptyTunnelForm();
    form.name = "SOCKS";
    form.kind = "dynamic";
    form.targetHost = "";
    form.targetPort = "";

    expect(tunnelValidationIssue(form)).toBeNull();
    expect(tunnelConfigFromForm(form, "ssh-prod")).toMatchObject({
      profileId: "ssh-prod",
      bindPort: 0,
      targetPort: 0,
    });
  });

  it("requires an endpoint for forwarding tunnels", () => {
    const form = emptyTunnelForm();
    form.name = "App";
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
    expect(tunnelConfigFromForm(form, "ssh-prod").bindPort).toBe(0);
  });
});
