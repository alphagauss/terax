/**
 * 本文件验证 AI 权限模式的动态审批与执行期安全边界。
 * 测试锁定完全访问只省略批准，不削弱 Shell 拒绝规则或外部 Agent 审批。
 */

import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../store/chatStore";
import { buildManagedAgentTools } from "./agent";
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
  injectIntoActivePty: () => false,
  spawnAgent: async () => null,
  readAgentOutput: () => null,
  getSessionId: () => "00000000-0000-4000-8000-000000000001",
};

describe("AI tool approval mode", () => {
  beforeEach(() => {
    nativeMock.shellExec.mockReset();
    nativeMock.shellProcess.mockReset();
    nativeMock.shellList.mockReset();
    useChatStore.setState({ permissionMode: "ask" });
  });

  it("requires approval by default and updates without rebuilding tools", () => {
    const tools = buildShellTools(context);
    const needsApproval = tools.shell_exec.needsApproval;
    if (typeof needsApproval !== "function") {
      throw new Error("shell_exec approval gate must be dynamic");
    }

    expect(needsApproval({ command: "echo safe" }, toolOptions)).toBe(true);
    useChatStore.setState({ permissionMode: "full-access" });
    expect(needsApproval({ command: "echo safe" }, toolOptions)).toBe(false);
  });

  it("keeps external coding-agent actions behind approval", () => {
    useChatStore.setState({ permissionMode: "full-access" });
    const tools = buildManagedAgentTools(context);
    expect(tools.spawn_coding_agent.needsApproval).toBe(true);
    expect(tools.send_to_agent.needsApproval).toBe(true);
  });

  it("still rejects destructive shell commands in full access", async () => {
    useChatStore.setState({ permissionMode: "full-access" });
    const tools = buildShellTools(context);
    const execute = tools.shell_exec.execute;
    if (!execute) throw new Error("shell_exec execute missing");

    const result = await execute({ command: "rm -rf /" }, toolOptions);
    expect(result).toMatchObject({
      error: expect.stringContaining("filesystem root"),
    });
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
