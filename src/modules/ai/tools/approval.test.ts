/**
 * 本文件验证 AI Shell 工具的输入约束、选择性审批与执行期权限传递。
 * 测试锁定工作区命令自动执行，越界和网络命令审批，以及聊天级进程隔离。
 */

import { asSchema, type ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "./context";
import { buildShellTools } from "./shell";

const nativeMock = vi.hoisted(() => ({
  shellExec: vi.fn(),
  shellProcess: vi.fn(),
  shellList: vi.fn(),
}));

vi.mock("../lib/native", () => ({ native: nativeMock }));

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

const context: ToolContext = {
  getCwd: () => "/workspace",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  getSessionId: () => "00000000-0000-4000-8000-000000000001",
  getPermissionMode: () => useChatStore.getState().permissionMode,
  supportsApprovals: true,
};

describe("AI tool approval mode", () => {
  beforeEach(() => {
    nativeMock.shellExec.mockReset();
    nativeMock.shellProcess.mockReset();
    nativeMock.shellList.mockReset();
    useChatStore.setState({ permissionMode: "ask" });
  });

  it("auto-runs workspace commands and approves external access", () => {
    const tools = buildShellTools(context);
    const needsApproval = tools.shell_exec.needsApproval;
    if (typeof needsApproval !== "function") {
      throw new Error("shell_exec approval gate must be dynamic");
    }

    expect(needsApproval({ command: "echo safe" }, toolOptions)).toBe(false);
    expect(
      needsApproval({ command: "curl https://example.com" }, toolOptions),
    ).toBe(true);
    useChatStore.setState({ permissionMode: "full-access" });
    expect(needsApproval({ command: "echo safe" }, toolOptions)).toBe(false);
    expect(
      needsApproval({ command: "curl https://example.com" }, toolOptions),
    ).toBe(false);
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
    useChatStore.setState({ permissionMode: "full-access" });
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

  it("only requires process approval when writing stdin", () => {
    const needsApproval = buildShellTools(context).shell_process.needsApproval;
    if (typeof needsApproval !== "function") {
      throw new Error("shell_process approval gate must be dynamic");
    }
    const processId = "00000000-0000-4000-8000-000000000002";
    expect(
      needsApproval({ process_id: processId, action: "poll" }, toolOptions),
    ).toBe(false);
    expect(
      needsApproval(
        { process_id: processId, action: "write", input: "yes\n" },
        toolOptions,
      ),
    ).toBe(true);
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

  it("scopes process control and discovery to the active chat", async () => {
    const processId = "00000000-0000-4000-8000-000000000002";
    nativeMock.shellProcess.mockResolvedValue({
      process_id: processId,
      status: "running",
      stdout: "",
      stderr: "",
    });
    nativeMock.shellList.mockResolvedValue([]);
    const tools = buildShellTools(context);
    if (!tools.shell_process.execute || !tools.shell_list.execute) {
      throw new Error("Shell process tools must be executable");
    }

    await tools.shell_process.execute(
      { process_id: processId, action: "poll" },
      toolOptions,
    );
    await tools.shell_list.execute({}, toolOptions);

    expect(nativeMock.shellProcess).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSessionId: context.getSessionId() }),
    );
    expect(nativeMock.shellList).toHaveBeenCalledWith(
      context.getSessionId(),
      false,
    );
  });
});
