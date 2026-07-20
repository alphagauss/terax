import { describe, expect, it } from "vitest";
import {
  emptySshProfileForm,
  launchSecretIssue,
  profileValidationIssue,
  sshProfileFromForm,
} from "./profileForm";

describe("SSH profile form", () => {
  it("creates a normalized profile with safe defaults", () => {
    const form = emptySshProfileForm("ssh-prod");
    form.host = "prod.example.com";
    form.username = "deploy";
    form.name = "";
    form.rootPath = "";

    expect(sshProfileFromForm(form)).toMatchObject({
      id: "ssh-prod",
      name: "deploy@prod.example.com",
      port: 22,
      rootPath: "~",
    });
  });

  it("reports the first invalid connection field", () => {
    const form = emptySshProfileForm("ssh-prod");
    expect(profileValidationIssue(form)).toBe("host");
    form.host = "prod.example.com";
    form.port = "0";
    expect(profileValidationIssue(form)).toBe("port");
    form.port = "22";
    form.username = "deploy";
    form.authMethod = "private_key";
    expect(profileValidationIssue(form)).toBe("identityFile");
  });

  it("keeps launch-only secrets in the credential vault", () => {
    const form = emptySshProfileForm("ssh-prod");
    form.secret = "secret";
    form.rememberSecret = false;
    expect(launchSecretIssue(form)).toBe("secret");
    form.rememberSecret = true;
    form.proxySecret = "proxy";
    form.rememberProxySecret = false;
    expect(launchSecretIssue(form)).toBe("proxy");
  });
});
