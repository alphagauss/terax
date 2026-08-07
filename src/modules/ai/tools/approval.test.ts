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
  shellBgSpawn: vi.fn(),
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
  openWebPreview: () => false,
  spawnAgent: async () => null,
  readAgentOutput: () => null,
  readCache: new Map(),
  getSessionId: () => "session",
};

describe("AI tool approval mode", () => {
  beforeEach(() => {
    nativeMock.shellBgSpawn.mockReset();
    useChatStore.setState({ permissionMode: "ask" });
  });

  it("requires approval by default and updates without rebuilding tools", () => {
    const tools = buildShellTools(context);
    const needsApproval = tools.bash_run.needsApproval;
    if (typeof needsApproval !== "function") {
      throw new Error("bash_run approval gate must be dynamic");
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
    const execute = tools.bash_run.execute;
    if (!execute) throw new Error("bash_run execute missing");

    const result = await execute({ command: "rm -rf /" }, toolOptions);
    expect(result).toMatchObject({
      error: expect.stringContaining("filesystem root"),
    });
  });

  it("resolves a background cwd against the fixed session directory", async () => {
    nativeMock.shellBgSpawn.mockResolvedValue(7);
    const execute = buildShellTools(context).bash_background.execute;
    if (!execute) throw new Error("bash_background execute missing");

    await execute({ command: "pnpm dev", cwd: "apps/web" }, toolOptions);

    expect(nativeMock.shellBgSpawn).toHaveBeenCalledWith(
      "pnpm dev",
      "/workspace/apps/web",
    );
  });
});
