/**
 * 本文件测试 SSH 配置表单的默认值、转换、校验和凭据变更规则。
 * 锁定空名称自动使用“用户名@主机”以及默认分组归属。
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_SSH_GROUP_ID } from "./groups";
import {
  credentialMutation,
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
      groupId: DEFAULT_SSH_GROUP_ID,
      name: "deploy@prod.example.com",
      port: 22,
      reconnectMaxAttempts: 2,
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
    form.identityFile = "~/.ssh/id_ed25519";
    form.keepaliveSeconds = "0.5";
    expect(profileValidationIssue(form)).toBe("keepalive");
    form.keepaliveSeconds = "30";
    form.reconnectMaxAttempts = "21";
    expect(profileValidationIssue(form)).toBe("reconnectAttempts");
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

  it("does not mutate a stored credential until the user changes its state", () => {
    expect(
      credentialMutation({
        value: "",
        dirty: false,
        remember: true,
        applicable: true,
      }),
    ).toEqual({ kind: "keep" });
    expect(
      credentialMutation({
        value: "",
        dirty: true,
        remember: true,
        applicable: true,
      }),
    ).toEqual({ kind: "delete" });
    expect(
      credentialMutation({
        value: "new secret",
        dirty: true,
        remember: true,
        applicable: true,
      }),
    ).toEqual({ kind: "set", value: "new secret" });
  });
});
