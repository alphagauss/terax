import { describe, expect, it } from "vitest";
import { launchOnlySecretError } from "./launchValidation";

const input = {
  launchOnly: true,
  secret: "",
  rememberSecret: true,
  proxySecret: "",
  rememberProxySecret: true,
};

describe("launchOnlySecretError", () => {
  it("blocks a password that cannot cross into the launched process", () => {
    expect(
      launchOnlySecretError({
        ...input,
        secret: "password",
        rememberSecret: false,
      }),
    ).toContain("cannot receive this password");
  });

  it("blocks an unstored proxy password", () => {
    expect(
      launchOnlySecretError({
        ...input,
        proxySecret: "proxy-password",
        rememberProxySecret: false,
      }),
    ).toContain("stored securely");
  });

  it("allows in-process connections and securely stored launch secrets", () => {
    expect(
      launchOnlySecretError({
        ...input,
        launchOnly: false,
        secret: "password",
        rememberSecret: false,
      }),
    ).toBeNull();
    expect(
      launchOnlySecretError({ ...input, secret: "password" }),
    ).toBeNull();
  });
});
