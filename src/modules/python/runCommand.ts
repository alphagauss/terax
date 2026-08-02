/**
 * 本文件为不同终端 Shell 构造运行 Python 文件的单行命令。
 * 只负责可靠引用路径，不执行命令，也不改变终端当前目录。
 */

import { IS_WINDOWS } from "@/lib/platform";
import type { WorkspaceEnv } from "@/modules/workspace";

type ShellSyntax = "posix" | "powershell" | "cmd";

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** 根据 Workspace 和终端配置判断新终端实际接受的命令语法。 */
export function pythonShellSyntax(
  workspace: WorkspaceEnv,
  terminalShell: string,
  hostWindows = IS_WINDOWS,
): ShellSyntax {
  if (workspace.kind !== "local" || !hostWindows) return "posix";
  const name = terminalShell
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase();
  if (name === "cmd" || name === "cmd.exe") return "cmd";
  if (name?.includes("bash") || name === "zsh" || name === "fish") {
    return "posix";
  }
  return "powershell";
}

/** 构造以明确解释器运行明确文件的终端命令，所有路径均作为单个参数引用。 */
export function buildPythonRunCommand(
  interpreterPath: string,
  filePath: string,
  workspace: WorkspaceEnv,
  terminalShell: string,
  hostWindows = IS_WINDOWS,
): string {
  const syntax = pythonShellSyntax(workspace, terminalShell, hostWindows);
  if (syntax === "posix") {
    return `${quotePosix(interpreterPath)} ${quotePosix(filePath)}`;
  }
  if (syntax === "cmd") {
    return `${quoteCmd(interpreterPath)} ${quoteCmd(filePath)}`;
  }
  return `& ${quotePowerShell(interpreterPath)} ${quotePowerShell(filePath)}`;
}
