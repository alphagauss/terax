/**
 * 本文件验证完整 AI 工具集发送给 provider 的 schema 协议形状。
 * 测试锁定根节点、字段类型、必填参数和额外字段策略，避免请求在工具调用前被拒绝。
 */

import { asSchema, type FlexibleSchema } from "ai";
import { describe, expect, it } from "vitest";
import { resolveAgentExecutionEnvironment } from "@/modules/ai/lib/prompt";
import type { ToolContext } from "./context";
import { buildShellTools } from "./shell";
import { buildTools } from "./tools";

const context: ToolContext = {
  getCwd: () => "/workspace",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  getSessionId: () => "00000000-0000-4000-8000-000000000001",
  getPermissionMode: () => "ask",
  supportsApprovals: true,
};

/** 判断字段 schema 是否直接声明类型，或由完整的类型联合组成。 */
function hasDeclaredJsonType(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return false;
  const definition = schema as Record<string, unknown>;
  if (definition.type !== undefined) return true;
  return [definition.anyOf, definition.oneOf].some(
    (variants) =>
      Array.isArray(variants) &&
      variants.length > 0 &&
      variants.every(hasDeclaredJsonType),
  );
}

describe("AI tool provider schemas", () => {
  it.each([
    [
      "Windows",
      { kind: "local" } as const,
      "windows" as const,
      /Win32_Process\.Create/,
      /Linux|macOS|WSL|SSH|nohup/,
    ],
    [
      "Linux",
      { kind: "local" } as const,
      "linux" as const,
      /local Linux/,
      /Windows|macOS|WSL|SSH|WMI|Start-Process/,
    ],
    [
      "macOS",
      { kind: "local" } as const,
      "macos" as const,
      /local macOS/,
      /Windows|Linux|WSL|SSH|WMI|Start-Process/,
    ],
    [
      "WSL",
      { kind: "wsl", distro: "Ubuntu" } as const,
      "windows" as const,
      /WSL distribution/,
      /Windows|macOS|SSH|WMI|Start-Process/,
    ],
    [
      "Linux SSH",
      { kind: "ssh", profileId: "server" } as const,
      "windows" as const,
      /SSH connection loss/,
      /Windows|macOS|WSL|WMI|Start-Process/,
    ],
  ])(
    "only describes the actual %s execution environment",
    (_name, workspace, host, expected, unrelated) => {
      const environment = resolveAgentExecutionEnvironment(workspace, host, []);
      const description =
        buildShellTools({ ...context, environment }).shell_exec.description ??
        "";
      expect(description).toMatch(expected);
      expect(description).not.toMatch(unrelated);
      if (environment.platform !== "Windows") {
        expect(description).toContain(
          "nohup ./server </dev/null >server.log 2>&1 & echo $!",
        );
      }
    },
  );

  const tools = buildTools({
    ...context,
    getMessageSender: () => async () => ({ status: "accepted", parts: [] }),
  });
  const requiredParameters = {
    read_file: ["path"],
    write_file: ["path", "content"],
    file_operation: ["operation", "path"],
    apply_patch: ["files"],
    find_files: [],
    grep: ["pattern"],
    shell_exec: ["command"],
    shell_process: ["process_id", "action"],
    shell_list: [],
    run_subagent: ["task"],
    subagent_task: ["action"],
    get_terminal_output: [],
    message: [],
  } satisfies Record<keyof typeof tools, readonly string[]>;
  const toolSchemas = Object.entries(tools).map(
    ([name, definition]) =>
      [
        name,
        definition.inputSchema as FlexibleSchema<unknown>,
        requiredParameters[name as keyof typeof tools],
      ] as const,
  );

  it.each(toolSchemas)(
    "%s uses a complete object parameter schema",
    async (_name, inputSchema, required) => {
      const jsonSchema = await asSchema(inputSchema).jsonSchema;

      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties).toBeDefined();
      expect(jsonSchema.additionalProperties).toBe(false);
      expect([...(jsonSchema.required ?? [])].sort()).toEqual(
        [...required].sort(),
      );
      for (const propertySchema of Object.values(jsonSchema.properties ?? {})) {
        expect(hasDeclaredJsonType(propertySchema)).toBe(true);
      }
    },
  );

  it.each([
    [
      { kind: "bash" as const, executable: "/bin/bash", version: "5.2" },
      ["default", "bash"],
      false,
    ],
    [
      { kind: "pwsh" as const, executable: "C:/pwsh.exe", version: "7.6" },
      ["default", "pwsh"],
      true,
    ],
    [
      {
        kind: "cmd" as const,
        executable: "C:/Windows/System32/cmd.exe",
        version: null,
      },
      ["default", "cmd"],
      false,
    ],
  ])(
    "exposes only detected shell selectors for %j",
    async (shell, selectors, powerShell) => {
      const tools = buildShellTools({
        ...context,
        environment: resolveAgentExecutionEnvironment(
          { kind: "local" },
          shell.kind === "bash" ? "linux" : "windows",
          [shell],
        ),
      });
      const schema = await asSchema(
        tools.shell_exec.inputSchema as FlexibleSchema<unknown>,
      ).jsonSchema;
      expect(schema.properties?.shell).toMatchObject({ enum: selectors });
      const text = JSON.stringify(schema);
      expect(text).not.toMatch(/WSL|SSH|Windows|Linux|macOS|remote|Local/);
      expect(text.includes("For PowerShell scripts")).toBe(powerShell);
    },
  );

  it("only exposes tools allowed by the session Agent snapshot", () => {
    expect(buildTools(context, ["message"])).not.toHaveProperty("message");
    expect(Object.keys(buildTools(context, ["read_file", "grep"]))).toEqual([
      "read_file",
      "grep",
    ]);
  });
});
