/**
 * 本文件测试跨平台文档路径身份。
 *
 * 锁定 Windows 大小写归一化和 WSL 宿主机事件路径还原规则。
 */

import type { WorkspaceEnv } from "@/modules/workspace";
import { describe, expect, it } from "vitest";
import {
  documentEventPath,
  documentEventResourceKey,
  documentPathIdentity,
  documentResourceKey,
} from "./pathIdentity";

const local: WorkspaceEnv = { kind: "local" };

describe("document path identity", () => {
  it("preserves the UNC prefix while normalizing separators", () => {
    expect(
      documentPathIdentity(local, "\\\\server\\share\\\\file.ts", true),
    ).toBe("//server/share/file.ts");
    expect(documentPathIdentity(local, "///server/share/file.ts", true)).toBe(
      "//server/share/file.ts",
    );
    expect(
      documentPathIdentity(local, "\\server\\share\\file.ts", true),
    ).not.toBe(documentPathIdentity(local, "\\\\server\\share\\file.ts", true));
  });

  it("uses case-insensitive identity only for local Windows workspaces", () => {
    expect(documentResourceKey(local, "C:\\Work\\FILE.ts", true)).toBe(
      documentResourceKey(local, "c:/work/file.ts", true),
    );

    const wsl: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu" };
    expect(documentResourceKey(wsl, "/Work/FILE.ts", true)).not.toBe(
      documentResourceKey(wsl, "/work/file.ts", true),
    );

    const ssh: WorkspaceEnv = { kind: "ssh", profileId: "dev" };
    expect(documentResourceKey(ssh, "/Work/FILE.ts", true)).not.toBe(
      documentResourceKey(ssh, "/work/file.ts", true),
    );
  });

  it("maps host watcher paths back to WSL logical paths", () => {
    const wsl: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu" };

    expect(
      documentEventPath(wsl, "//wsl.localhost/Ubuntu/home/me/file.ts"),
    ).toBe("/home/me/file.ts");
    expect(documentEventPath(wsl, "//wsl$/ubuntu/etc/hosts")).toBe(
      "/etc/hosts",
    );
    expect(documentEventPath(wsl, "C:/work/file.ts")).toBe(
      "/mnt/c/work/file.ts",
    );
  });

  it("matches local event paths with Windows casing differences", () => {
    expect(documentEventResourceKey(local, "C:/Work/File.ts", true)).toBe(
      documentResourceKey(local, "c:/work/file.ts", true),
    );
  });
});
