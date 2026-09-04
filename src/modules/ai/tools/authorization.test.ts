/**
 * 本文件测试请求批准模式的工具风险分类。
 * 测试锁定 cwd 内自动执行，以及越界、敏感路径、网络和不透明 Shell 调用触发审批。
 */

import { describe, expect, it } from "vitest";
import {
  fileOperationNeedsApproval,
  pathNeedsApproval,
  shellNeedsApproval,
} from "./authorization";

describe("AI tool approval classification", () => {
  it("allows ordinary workspace paths and escalates outside or sensitive paths", () => {
    expect(pathNeedsApproval("src/main.ts", "/workspace")).toBe(false);
    expect(pathNeedsApproval("../shared/config.json", "/workspace")).toBe(true);
    expect(pathNeedsApproval("/workspace/.env", "/workspace")).toBe(true);
    expect(pathNeedsApproval("passwd", "/etc")).toBe(true);
    expect(pathNeedsApproval("C:\\repo\\src\\main.ts", "C:\\repo")).toBe(false);
    expect(pathNeedsApproval("C:\\other\\main.ts", "C:\\repo")).toBe(true);
    expect(pathNeedsApproval("\\Windows\\System32", "C:\\repo")).toBe(true);
    expect(
      pathNeedsApproval(
        "\\\\SERVER\\Share\\repo\\src\\main.ts",
        "\\\\server\\share\\repo",
      ),
    ).toBe(false);
    for (const path of [
      ".git/config",
      ".docker/config.json",
      ".config/gh/hosts.yml",
      "authorized_keys",
      "credentials.backup",
      "secret.json",
      "/Library/Keychains/login.keychain-db",
      "C:\\ProgramData\\app\\config.json",
    ]) {
      expect(pathNeedsApproval(path, "/workspace"), path).toBe(true);
    }
  });

  it("escalates recursive deletion and operations on the session root", () => {
    expect(
      fileOperationNeedsApproval(
        { operation: "delete", path: "build", recursive: true },
        "/workspace",
      ),
    ).toBe(true);
    expect(
      fileOperationNeedsApproval(
        { operation: "move", path: ".", destination: "archive" },
        "/workspace",
      ),
    ).toBe(true);
    expect(
      fileOperationNeedsApproval(
        { operation: "move", path: "old.txt", destination: "new.txt" },
        "/workspace",
      ),
    ).toBe(false);
  });

  it("escalates shell calls that can leave the workspace or access the network", () => {
    expect(shellNeedsApproval("pnpm test", null, "/workspace")).toBe(false);
    expect(shellNeedsApproval("cat ../secret", null, "/workspace")).toBe(true);
    expect(
      shellNeedsApproval("curl https://example.com", null, "/workspace"),
    ).toBe(true);
    expect(shellNeedsApproval("pnpm install", null, "/workspace")).toBe(true);
    expect(shellNeedsApproval("pnpm dlx eslint .", null, "/workspace")).toBe(
      true,
    );
    expect(shellNeedsApproval("cat .env", null, "/workspace")).toBe(true);
    expect(shellNeedsApproval("cat .npmrc", null, "/workspace")).toBe(true);
    expect(shellNeedsApproval("cat $TARGET", null, "/workspace")).toBe(true);
    expect(
      shellNeedsApproval("cat $(resolve-path file)", null, "/workspace"),
    ).toBe(true);
    expect(shellNeedsApproval("python -c 'print(1)'", null, "/workspace")).toBe(
      true,
    );
    expect(
      shellNeedsApproval("bash -c 'echo shutdown'", null, "/workspace"),
    ).toBe(true);
    expect(shellNeedsApproval("pnpm test", "/other", "/workspace")).toBe(true);
    expect(shellNeedsApproval("cat /other/secret", null, "/workspace")).toBe(
      true,
    );
    expect(shellNeedsApproval("rm -rf build", null, "/workspace")).toBe(true);
    expect(shellNeedsApproval("rm -rf /", null, "/workspace")).toBe(false);
    expect(
      shellNeedsApproval(
        "Remove-Item C:\\ -Recurse -Force",
        null,
        "C:\\workspace",
      ),
    ).toBe(false);
    expect(shellNeedsApproval("diskpart", null, "C:\\workspace")).toBe(false);
    expect(
      shellNeedsApproval("cmd /c shutdown /s /t 0", null, "C:\\workspace"),
    ).toBe(false);
  });
});
