/**
 * 本文件定义 Custom Agent 可选择的内置工具目录。
 * 工具 ID 使用稳定顺序保存，工具组只服务于设置界面，编辑工具只依赖文件读取。
 */

export const AGENT_TOOL_IDS = [
  "read_file",
  "find_files",
  "grep",
  "write_file",
  "apply_patch",
  "file_operation",
  "shell_exec",
  "shell_process",
  "shell_list",
  "get_terminal_output",
  "run_subagent",
  "subagent_task",
  "message",
] as const;

export type AgentToolId = (typeof AGENT_TOOL_IDS)[number];

export const AGENT_TOOL_GROUPS = [
  {
    id: "workspaceRead",
    tools: ["read_file", "find_files", "grep"],
  },
  {
    id: "workspaceWrite",
    tools: ["write_file", "apply_patch", "file_operation"],
  },
  {
    id: "shell",
    tools: ["shell_exec", "shell_process", "shell_list"],
  },
  {
    id: "terminal",
    tools: ["get_terminal_output"],
  },
  {
    id: "subagents",
    tools: ["run_subagent", "subagent_task"],
  },
  { id: "channels", tools: ["message"] },
] as const satisfies readonly {
  id: string;
  tools: readonly AgentToolId[];
}[];

const TOOL_IDS = new Set<string>(AGENT_TOOL_IDS);
const EDIT_TOOLS: readonly AgentToolId[] = ["write_file", "apply_patch"];
const SUBAGENT_READ_ONLY_TOOLS = new Set<AgentToolId>([
  "read_file",
  "find_files",
  "grep",
  "get_terminal_output",
]);

/** 将工具列表规范为稳定顺序，并补齐编辑工具真正需要的文件读取能力。 */
export function normalizeAgentTools(value: readonly unknown[]): AgentToolId[] {
  const selected = new Set(
    value.filter(
      (tool): tool is AgentToolId =>
        typeof tool === "string" && TOOL_IDS.has(tool),
    ),
  );
  if (EDIT_TOOLS.some((tool) => selected.has(tool))) selected.add("read_file");
  return AGENT_TOOL_IDS.filter((tool) => selected.has(tool));
}

/** 独立切换工具；关闭文件读取时同步移除依赖它的编辑工具。 */
export function setAgentToolEnabled(
  tools: readonly AgentToolId[],
  id: AgentToolId,
  enabled: boolean,
): AgentToolId[] {
  const selected = new Set(tools);
  if (enabled) selected.add(id);
  else {
    selected.delete(id);
    if (id === "read_file")
      for (const tool of EDIT_TOOLS) selected.delete(tool);
  }
  return normalizeAgentTools([...selected]);
}

/** Channel 没有活动桌面终端，不能通过配置启用该能力。 */
export function availableAgentTools(channel: boolean): AgentToolId[] {
  return AGENT_TOOL_IDS.filter((id) =>
    channel ? id !== "get_terminal_output" : id !== "message",
  );
}

/**
 * 根据父 Agent 白名单和启动时权限快照计算 Subagent 工具。
 *
 * 请求批准模式进一步收窄到只读工具；完全访问模式保持父白名单。
 * 两种模式都移除 `run_subagent`，从 schema 层禁止递归创建。
 */
export function resolveSubagentTools(
  parentTools: readonly AgentToolId[],
  permissionMode: "ask" | "full-access",
): AgentToolId[] {
  return normalizeAgentTools(parentTools).filter(
    (tool) =>
      tool !== "run_subagent" &&
      tool !== "subagent_task" &&
      tool !== "message" &&
      (permissionMode === "full-access" || SUBAGENT_READ_ONLY_TOOLS.has(tool)),
  );
}
