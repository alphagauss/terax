import { describe, expect, it } from "vitest";
import {
  emptyTunnelForm,
  tunnelConfigFromForm,
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
  });
});
