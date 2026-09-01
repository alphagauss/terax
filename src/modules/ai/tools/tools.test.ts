/**
 * 本文件验证完整 AI 工具集发送给 provider 的 schema 协议形状。
 * 测试锁定根节点、字段类型、必填参数和额外字段策略，避免请求在工具调用前被拒绝。
 */

import { asSchema, type FlexibleSchema } from "ai";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "./context";
import { buildTools } from "./tools";

const context: ToolContext = {
  getCwd: () => "/workspace",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  getSessionId: () => "00000000-0000-4000-8000-000000000001",
  getPermissionMode: () => "ask",
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
  const tools = buildTools(context);
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
    get_terminal_output: [],
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

  it("only exposes tools allowed by the session Agent snapshot", () => {
    expect(Object.keys(buildTools(context, ["read_file", "grep"]))).toEqual([
      "read_file",
      "grep",
    ]);
  });
});
