/**
 * 本文件验证 AI Shell 工具的输入约束、选择性审批与执行期权限传递。
 * 测试锁定工作区命令自动执行，越界和网络命令审批，以及聊天级进程隔离。
 */

import { asSchema, type ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildToolApproval } from "./approval";
import type { ToolContext } from "./context";
import { buildShellTools } from "./shell";

const nativeMock = vi.hoisted(() => ({
  shellExec: vi.fn(),
  shellProcess: vi.fn(),
  shellList: vi.fn(),
}));

vi.mock("../lib/native", () => ({ native: nativeMock }));

const toolOptions: ToolExecutionOptions<never> = {
  toolCallId: "tool-call",
  messages: [],
  context: undefined as never,
};

let permissionMode: "ask" | "full-access" = "ask";

const context: ToolContext = {
  getCwd: () => "/workspace",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  getSessionId: () => "00000000-0000-4000-8000-000000000001",
  getPermissionMode: () => permissionMode,
  supportsApprovals: true,
};

describe("AI tool approval mode", () => {
  beforeEach(() => {
    nativeMock.shellExec.mockReset();
    nativeMock.shellProcess.mockReset();
    nativeMock.shellList.mockReset();
    permissionMode = "ask";
  });

  it("auto-runs workspace commands and approves external access", () => {
    const approval = buildToolApproval(context).shell_exec;

    expect(approval({ command: "echo safe" })).toBe("not-applicable");
    expect(approval({ command: "curl https://example.com" })).toBe(
      "user-approval",
    );
    permissionMode = "full-access";
    expect(approval({ command: "echo safe" })).toBe("not-applicable");
    expect(approval({ command: "curl https://example.com" })).toBe(
      "not-applicable",
    );
  });

  it("elevates only a shell call classified for approval", async () => {
    nativeMock.shellExec.mockResolvedValue({ status: "exited", stdout: "" });
    const execute = buildShellTools(context).shell_exec.execute;
    if (!execute) throw new Error("shell_exec execute missing");

    await execute({ command: "curl https://example.com" }, toolOptions);

    expect(nativeMock.shellExec).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "full-access" }),
    );
  });

  it("passes full access to the native Shell boundary", async () => {
    permissionMode = "full-access";
    nativeMock.shellExec.mockResolvedValue({ status: "exited", stdout: "" });
    const tools = buildShellTools(context);
    const execute = tools.shell_exec.execute;
    if (!execute) throw new Error("shell_exec execute missing");

    await execute({ command: "echo safe" }, toolOptions);
    expect(nativeMock.shellExec).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "full-access" }),
    );
  });

  it("resolves a process cwd against the fixed session directory", async () => {
    nativeMock.shellExec.mockResolvedValue({
      process_id: "00000000-0000-4000-8000-000000000002",
      status: "running",
    });
    const execute = buildShellTools(context).shell_exec.execute;
    if (!execute) throw new Error("shell_exec execute missing");

    await execute({ command: "pnpm dev", cwd: "apps/web" }, toolOptions);

    expect(nativeMock.shellExec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "pnpm dev",
        cwd: "/workspace/apps/web",
        permissionMode: "ask",
        timeoutSecs: 300,
        yieldTimeMs: 10_000,
      }),
    );
  });

  it("disables the process timeout only for an explicit null", async () => {
    nativeMock.shellExec.mockResolvedValue({ status: "running", stdout: "" });
    const execute = buildShellTools(context).shell_exec.execute;
    if (!execute) throw new Error("shell_exec execute missing");

    await execute({ command: "pnpm dev", timeout_secs: null }, toolOptions);

    expect(nativeMock.shellExec).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSecs: 0 }),
    );
  });

  it("only requires process approval when writing stdin", () => {
    const approval = buildToolApproval(context).shell_process;
    const processId = "00000000-0000-4000-8000-000000000002";
    expect(approval({ process_id: processId, action: "poll" })).toBe(
      "not-applicable",
    );
    expect(
      approval({ process_id: processId, action: "write", input: "yes\n" }),
    ).toBe("user-approval");
  });

  it("requires input when writing to a process", async () => {
    const inputSchema = buildShellTools(context).shell_process.inputSchema;
    const schema = asSchema(inputSchema);
    if (!schema.validate) throw new Error("shell_process validator missing");

    expect(
      await schema.validate({
        process_id: "00000000-0000-4000-8000-000000000002",
        action: "write",
      }),
    ).toMatchObject({ success: false });
    expect(
      await schema.validate({
        process_id: "00000000-0000-4000-8000-000000000002",
        action: "poll",
      }),
    ).toMatchObject({ success: true });
  });

  it.each([0, 30000, -1, 30001, 60000, 120000, 0.5])(
    "validates shell wait boundaries without clamping (%s)",
    async (yieldTimeMs) => {
      const tools = buildShellTools(context);
      const inputs = [
        [asSchema(tools.shell_exec.inputSchema), { command: "echo safe" }],
        [
          asSchema(tools.shell_process.inputSchema),
          {
            process_id: "00000000-0000-4000-8000-000000000002",
            action: "poll",
          },
        ],
      ] as const;
      for (const [schema, input] of inputs) {
        if (!schema.validate) throw new Error("shell validator missing");
        const result = await schema.validate({
          ...input,
          yield_time_ms: yieldTimeMs,
        });
        expect(result.success).toBe(yieldTimeMs === 0 || yieldTimeMs === 30000);
        if (result.success)
          expect(result.value.yield_time_ms).toBe(yieldTimeMs);
      }
    },
  );

  it.each([
    ["poll", undefined, true],
    ["write", "status\n", true],
    ["close_stdin", undefined, false],
    ["terminate", undefined, false],
    ["wait_for", undefined, false],
  ])(
    "wait_for with action=%s follows native validation",
    async (action, input, success) => {
      const schema = asSchema(
        buildShellTools(context).shell_process.inputSchema,
      );
      if (!schema.validate) throw new Error("shell_process validator missing");
      expect(
        await schema.validate({
          process_id: "00000000-0000-4000-8000-000000000002",
          action,
          input,
          wait_for: "ready",
        }),
      ).toMatchObject({ success });
    },
  );

  it.each([
    ["input", { action: "poll", input: "status\n" }],
    ["close_stdin", { action: "terminate", close_stdin: true }],
    ["wait_timeout_ms", { action: "poll", wait_timeout_ms: 5000 }],
    [
      "yield_time_ms",
      { action: "poll", wait_for: "ready", yield_time_ms: 5000 },
    ],
  ])("rejects ignored process option %s", async (_field, input) => {
    const schema = asSchema(buildShellTools(context).shell_process.inputSchema);
    if (!schema.validate) throw new Error("shell_process validator missing");

    expect(
      await schema.validate({
        process_id: "00000000-0000-4000-8000-000000000002",
        ...input,
      }),
    ).toMatchObject({ success: false });
  });

  it.each(["poll", "close_stdin", "terminate"])(
    "accepts close_stdin=false with action=%s",
    async (action) => {
      const schema = asSchema(
        buildShellTools(context).shell_process.inputSchema,
      );
      if (!schema.validate) throw new Error("shell_process validator missing");

      expect(
        await schema.validate({
          process_id: "00000000-0000-4000-8000-000000000002",
          action,
          close_stdin: false,
        }),
      ).toMatchObject({ success: true });
    },
  );

  it("scopes process control and discovery to the active chat", async () => {
    const processId = "00000000-0000-4000-8000-000000000002";
    nativeMock.shellProcess.mockResolvedValue({
      process_id: processId,
      status: "running",
      stdout: "",
      stderr: "",
    });
    nativeMock.shellList.mockResolvedValue([
      {
        process_id: processId,
        task_id: "abcd",
        execution_id: "private-run",
        command: "server",
      },
    ]);
    const tools = buildShellTools(context);
    if (!tools.shell_process.execute || !tools.shell_list.execute) {
      throw new Error("Shell process tools must be executable");
    }

    await tools.shell_process.execute(
      { process_id: processId, action: "poll" },
      toolOptions,
    );
    const listed = await tools.shell_list.execute({}, toolOptions);
    expect(listed).toMatchObject({ processes: [{ task_id: "abcd" }] });
    expect(JSON.stringify(listed)).not.toContain("private-run");

    expect(nativeMock.shellProcess).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSessionId: context.getSessionId() }),
    );
    expect(nativeMock.shellList).toHaveBeenCalledWith(
      context.getSessionId(),
      false,
    );
  });
});
