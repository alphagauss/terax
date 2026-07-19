import type { WorkspaceEnv } from "@/modules/workspace";
import { describe, expect, it } from "vitest";
import { documentPathIdentity, documentResourceKey } from "./pathIdentity";

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
});
