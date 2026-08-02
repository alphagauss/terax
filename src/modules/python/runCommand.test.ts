/**
 * 本文件测试 Python 运行命令在各类 Workspace Shell 中的路径引用规则。
 * 锁定空格、单引号与 Windows Shell 分流，避免运行错误文件或解释器。
 */

import { describe, expect, it } from "vitest";
import { buildPythonRunCommand, pythonShellSyntax } from "./runCommand";

describe("Python run command", () => {
  it("quotes PowerShell paths with embedded apostrophes", () => {
    expect(
      buildPythonRunCommand(
        "C:/It's Python/python.exe",
        "C:/work/my script.py",
        { kind: "local" },
        "pwsh.exe",
        true,
      ),
    ).toBe("& 'C:/It''s Python/python.exe' 'C:/work/my script.py'");
  });

  it("uses cmd quoting for cmd.exe", () => {
    expect(
      buildPythonRunCommand(
        "C:/Program Files/Python/python.exe",
        "C:/work/my script.py",
        { kind: "local" },
        "cmd.exe",
        true,
      ),
    ).toBe('"C:/Program Files/Python/python.exe" "C:/work/my script.py"');
  });

  it("uses POSIX quoting for apostrophes", () => {
    expect(
      buildPythonRunCommand(
        "/opt/user's python/bin/python",
        "/work/user's script.py",
        { kind: "local" },
        "/bin/zsh",
        false,
      ),
    ).toBe("'/opt/user'\\''s python/bin/python' '/work/user'\\''s script.py'");
  });

  it("always treats WSL and SSH terminals as POSIX shells", () => {
    expect(
      pythonShellSyntax({ kind: "wsl", distro: "Ubuntu" }, "cmd.exe", true),
    ).toBe("posix");
    expect(
      pythonShellSyntax({ kind: "ssh", profileId: "server" }, "pwsh.exe", true),
    ).toBe("posix");
  });
});
