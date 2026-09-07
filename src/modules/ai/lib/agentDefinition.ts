/**
 * 本文件定义可跨宿主复用的 Agent 身份、工具白名单和会话快照。
 * 仅处理业务数据，不加载桌面翻译、设置或 IPC 模块。
 */

import {
  AGENT_TOOL_IDS,
  type AgentToolId,
  normalizeAgentTools,
} from "@/modules/ai/lib/agentTools";

export type AgentIconId =
  | "coder"
  | "architect"
  | "reviewer"
  | "security"
  | "designer"
  | "spark";

export type Agent = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon: AgentIconId;
  tools: AgentToolId[];
};

export type SessionAgentSnapshot = Pick<
  Agent,
  "id" | "name" | "instructions" | "icon" | "tools"
>;

export const MAIN_AGENT_ID = "builtin:main";

export const MAIN_AGENT: Readonly<Agent> = {
  id: MAIN_AGENT_ID,
  name: "Terax",
  description: "Built-in general-purpose engineering agent with all tools.",
  instructions: "",
  icon: "coder",
  tools: [...AGENT_TOOL_IDS],
};

const AGENT_ICONS = new Set<AgentIconId>([
  "coder",
  "architect",
  "reviewer",
  "security",
  "designer",
  "spark",
]);

/** 将不可信持久化值规范为已知 Agent 图标。 */
export function normalizeAgentIcon(
  value: unknown,
  fallback: AgentIconId = "spark",
): AgentIconId {
  return AGENT_ICONS.has(value as AgentIconId)
    ? (value as AgentIconId)
    : fallback;
}

/** 从 Custom Agent 列表解析指定定义，无效 ID 统一回退固定主 Agent。 */
export function findAgent(
  customAgents: readonly Agent[],
  id: string | null | undefined,
): Agent {
  const main = () => ({ ...MAIN_AGENT, tools: [...MAIN_AGENT.tools] });
  if (!id || id === MAIN_AGENT_ID) return main();
  return customAgents.find((agent) => agent.id === id) ?? main();
}

/** 创建与后续 Agent 编辑解耦的会话运行快照。 */
export function snapshotAgent(agent: Agent): SessionAgentSnapshot {
  return {
    id: agent.id,
    name: agent.name,
    instructions: agent.instructions,
    icon: agent.icon,
    tools: normalizeAgentTools(agent.tools),
  };
}

/** 从不透明会话 metadata 值恢复 Agent 快照，旧会话统一归入主 Agent。 */
export function parseSessionAgent(value: unknown): SessionAgentSnapshot {
  if (!value || typeof value !== "object")
    return snapshotAgent(findAgent([], null));
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.instructions !== "string"
  ) {
    return snapshotAgent(findAgent([], null));
  }
  if (record.id === MAIN_AGENT_ID) {
    return snapshotAgent(findAgent([], null));
  }
  const icon = normalizeAgentIcon(record.icon);
  return {
    id: record.id,
    name: record.name,
    instructions: record.instructions,
    icon,
    tools: normalizeAgentTools(record.tools),
  };
}
