/**
 * 本文件测试 Custom Agent 工具目录和设置界面的工具组依赖。
 * 锁定旧定义默认完整工具、空列表保留以及修改能力自动包含读取能力。
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_IDS,
  agentToolGroupEnabled,
  normalizeAgentTools,
  resolveSubagentTools,
  setAgentToolGroupEnabled,
} from "./agentTools";

describe("agent tool selection", () => {
  it("migrates missing values to all tools and preserves an empty allowlist", () => {
    expect(normalizeAgentTools(undefined)).toEqual(AGENT_TOOL_IDS);
    expect(normalizeAgentTools([])).toEqual([]);
  });

  it("keeps canonical order and removes unknown values", () => {
    expect(normalizeAgentTools(["grep", "unknown", "read_file"])).toEqual([
      "read_file",
      "grep",
    ]);
  });

  it("enabling writes adds reads and disabling reads removes writes", () => {
    const writable = setAgentToolGroupEnabled([], "workspaceWrite", true);
    expect(agentToolGroupEnabled(writable, "workspaceRead")).toBe(true);
    expect(agentToolGroupEnabled(writable, "workspaceWrite")).toBe(true);

    const disabled = setAgentToolGroupEnabled(writable, "workspaceRead", false);
    expect(agentToolGroupEnabled(disabled, "workspaceRead")).toBe(false);
    expect(agentToolGroupEnabled(disabled, "workspaceWrite")).toBe(false);
  });

  it("narrows ask-mode subagents to the parent's read-only tools", () => {
    expect(
      resolveSubagentTools(
        ["read_file", "grep", "write_file", "shell_exec", "run_subagent"],
        "ask",
      ),
    ).toEqual(["read_file", "find_files", "grep"]);
  });

  it("inherits full access without exposing recursive subagents", () => {
    expect(
      resolveSubagentTools(
        ["read_file", "write_file", "shell_exec", "run_subagent"],
        "full-access",
      ),
    ).toEqual(["read_file", "find_files", "grep", "write_file", "shell_exec"]);
  });
});
