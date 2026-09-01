/**
 * 本文件定义 Custom Agent 可选择的内置工具目录。
 * 工具 ID 使用稳定顺序保存，工具组只服务于设置界面并约束必要依赖。
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
    tools: ["run_subagent"],
  },
] as const satisfies readonly {
  id: string;
  tools: readonly AgentToolId[];
}[];

export type AgentToolGroupId = (typeof AGENT_TOOL_GROUPS)[number]["id"];

const TOOL_IDS = new Set<string>(AGENT_TOOL_IDS);
const READ_TOOLS = AGENT_TOOL_GROUPS[0].tools;
const WRITE_TOOLS = AGENT_TOOL_GROUPS[1].tools;
const SUBAGENT_READ_ONLY_TOOLS = new Set<AgentToolId>([
  "read_file",
  "find_files",
  "grep",
  "get_terminal_output",
]);

/**
 * 将持久化工具列表规范为已知 ID 的稳定顺序。
 *
 * 缺失值来自旧版 Custom Agent，按完整工具集迁移；空数组则保留无工具语义。
 * 修改工具依赖读取工具，因此发现任一修改工具时自动补齐读取组。
 */
export function normalizeAgentTools(value: unknown): AgentToolId[] {
  if (!Array.isArray(value)) return [...AGENT_TOOL_IDS];
  const selected = new Set(
    value.filter(
      (tool): tool is AgentToolId =>
        typeof tool === "string" && TOOL_IDS.has(tool),
    ),
  );
  if (WRITE_TOOLS.some((tool) => selected.has(tool))) {
    for (const tool of READ_TOOLS) selected.add(tool);
  }
  return AGENT_TOOL_IDS.filter((tool) => selected.has(tool));
}

/** 判断一个工具组是否完整启用。 */
export function agentToolGroupEnabled(
  tools: readonly AgentToolId[],
  groupId: AgentToolGroupId,
): boolean {
  const selected = new Set(tools);
  const group = AGENT_TOOL_GROUPS.find((item) => item.id === groupId);
  return Boolean(group?.tools.every((tool) => selected.has(tool)));
}

/**
 * 切换设置界面的工具组，并维护修改依赖读取的不变量。
 * 关闭读取组时同时关闭修改组，避免保存无法实际工作的工具组合。
 */
export function setAgentToolGroupEnabled(
  tools: readonly AgentToolId[],
  groupId: AgentToolGroupId,
  enabled: boolean,
): AgentToolId[] {
  const selected = new Set(tools);
  const group = AGENT_TOOL_GROUPS.find((item) => item.id === groupId);
  if (!group) return normalizeAgentTools(tools);
  for (const tool of group.tools) {
    if (enabled) selected.add(tool);
    else selected.delete(tool);
  }
  if (groupId === "workspaceWrite" && enabled) {
    for (const tool of READ_TOOLS) selected.add(tool);
  }
  if (groupId === "workspaceRead" && !enabled) {
    for (const tool of WRITE_TOOLS) selected.delete(tool);
  }
  return normalizeAgentTools([...selected]);
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
      (permissionMode === "full-access" || SUBAGENT_READ_ONLY_TOOLS.has(tool)),
  );
}
