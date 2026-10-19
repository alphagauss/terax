import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { buildTools } from "./tools";

const tools = buildTools({
  getCwd: () => "/workspace",
  getSessionId: () => "session",
  getPermissionMode: () => "ask",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  supportsApprovals: true,
  getMessageSender: () => async () => ({ status: "accepted", parts: [] }),
});

describe("内置工具参数协议", () => {
  it.each(Object.entries(tools))(
    "%s 的嵌套入参字段统一为 snake_case",
    async (_name, tool) => {
      const schema = await asSchema<unknown>(tool.inputSchema).jsonSchema;
      function inspect(value: unknown): void {
        if (!value || typeof value !== "object") return;
        if ("properties" in value && value.properties) {
          for (const key of Object.keys(value.properties))
            expect(key).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
        }
        for (const child of Object.values(value)) inspect(child);
      }
      inspect(schema);
    },
  );

  it("保留未知字段忽略行为，不将 camelCase 当成别名", async () => {
    if (!tools.subagent_task) throw new Error("Missing subagent tool");
    const schema = asSchema(tools.subagent_task.inputSchema);
    if (!schema.validate) throw new Error("Missing validator");
    expect(
      await schema.validate({
        action: "wait",
        task_id: "abcd",
        timeout_ms: 1000,
        extra: true,
      }),
    ).toMatchObject({
      success: true,
      value: { action: "wait", task_id: "abcd", timeout_ms: 1000 },
    });
    expect(
      await schema.validate({ action: "wait", taskId: "abcd" }),
    ).toMatchObject({ success: false });
    expect(
      await schema.validate({
        action: "wait",
        task_id: "abcd",
        timeoutMs: 1000,
      }),
    ).toEqual({
      success: true,
      value: { action: "wait", task_id: "abcd" },
    });
  });
});
