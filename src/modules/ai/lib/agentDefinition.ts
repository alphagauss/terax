/**
 * 本文件定义可跨宿主复用的 Agent 身份、工具白名单和会话快照。
 * 仅处理业务数据，不加载桌面翻译、设置或 IPC 模块。
 */

import {
  type AgentToolId,
  normalizeAgentTools,
  availableAgentTools,
} from "@/modules/ai/lib/agentTools";

import DESKTOP_PROMPT from "@/modules/ai/prompts/desktop";
import CHANNEL_PROMPT from "@/modules/ai/prompts/channel";

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
  workspaceFiles: string[];
  icon: AgentIconId;
  tools: AgentToolId[];
};

export type SessionAgentSnapshot = Pick<Agent, "id" | "name" | "icon">;

export const MAIN_AGENT_ID = "builtin:main";

export const MAIN_AGENT: Readonly<Agent> = {
  id: MAIN_AGENT_ID,
  name: "Terax",
  description: "Built-in general-purpose engineering agent with all tools.",
  instructions: DESKTOP_PROMPT.trim(),
  workspaceFiles: ["AGENTS.md"],
  icon: "coder",
  tools: availableAgentTools(false),
};

export const CHANNEL_AGENT_ID = "builtin:channel";
export const CHANNEL_AGENT: Readonly<Agent> = {
  id: CHANNEL_AGENT_ID,
  name: "Channel",
  description: "Agent for instant messaging channels.",
  instructions: CHANNEL_PROMPT.trim(),
  workspaceFiles: ["AGENTS.md"],
  icon: "spark",
  tools: availableAgentTools(true),
};
export const BUILTIN_AGENTS = [MAIN_AGENT, CHANNEL_AGENT] as const;

/** 内置身份固定，提示词、工作区文件和工具允许按字段覆盖。 */
export function builtinAgent(id: string): Readonly<Agent> | undefined {
  return BUILTIN_AGENTS.find((agent) => agent.id === id);
}

/** 解析英文逗号分隔的相对文件路径，禁止绝对路径、越界和通配符。 */
export function parseWorkspaceFiles(value: string): string[] {
  const paths = value
    .split(",")
    .map((path) => path.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  const normalized = paths.map((path) => {
    if (
      path.startsWith("/") ||
      /[:*?[\]\x00-\x1f]/.test(path) ||
      path.split("/").includes("..")
    )
      throw new Error("Invalid workspace instruction path");
    const result = path
      .split("/")
      .filter((part) => part && part !== ".")
      .join("/");
    if (!result) throw new Error("Invalid workspace instruction path");
    return result;
  });
  return [...new Set(normalized)];
}

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

/** 解析草稿选择，尚未选择或已删除的定义回到主智能体。 */
export function findAgent(
  agents: readonly Agent[],
  id: string | null | undefined,
): Agent {
  return (
    agents.find((agent) => agent.id === id) ??
    agents.find((agent) => agent.id === MAIN_AGENT_ID) ??
    MAIN_AGENT
  );
}

/** 会话只保存固定身份；指令和工具在每轮开始时从当前配置读取。 */
export function snapshotAgent(
  agent: Pick<Agent, "id" | "name" | "icon">,
): SessionAgentSnapshot {
  return { id: agent.id, name: agent.name, icon: agent.icon };
}

/** 严格恢复会话身份，不将损坏或已删除的智能体替换成其他智能体。 */
export function parseSessionAgent(value: unknown): SessionAgentSnapshot {
  if (!value || typeof value !== "object")
    throw new Error("Invalid session agent");
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.name !== "string"
  )
    throw new Error("Invalid session agent");
  return {
    id: record.id,
    name: record.name,
    icon: normalizeAgentIcon(record.icon),
  };
}

/** 解析配置记录，内置智能体仅回退缺失的覆盖字段，自定义智能体必须完整。 */
export function parseAgentRecord(id: string, value: unknown): Agent | null {
  const defaults = builtinAgent(id);
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const merged = defaults
    ? {
        ...defaults,
        ...record,
        id: defaults.id,
        name: defaults.name,
        description: defaults.description,
        icon: defaults.icon,
      }
    : record;
  if (
    !id ||
    merged.id !== id ||
    (!defaults && id.startsWith("builtin:")) ||
    typeof merged.name !== "string" ||
    !merged.name.trim() ||
    typeof merged.description !== "string" ||
    typeof merged.instructions !== "string" ||
    !Array.isArray(merged.tools) ||
    !Array.isArray(merged.workspaceFiles) ||
    !merged.workspaceFiles.every((path) => typeof path === "string")
  )
    return null;
  try {
    return {
      id,
      name: merged.name,
      description: merged.description,
      instructions: merged.instructions,
      icon: normalizeAgentIcon(merged.icon),
      tools: normalizeAgentTools(merged.tools).filter((tool) =>
        availableAgentTools(id === CHANNEL_AGENT_ID).includes(tool),
      ),
      workspaceFiles: parseWorkspaceFiles(merged.workspaceFiles.join(",")),
    };
  } catch {
    return null;
  }
}

/** 合并出厂定义与配置记录，不迁移旧格式。 */
export function resolveAgentRecords(values: Record<string, unknown>): Agent[] {
  return [
    ...BUILTIN_AGENTS.map((agent) => agent.id),
    ...Object.keys(values)
      .filter((key) => key.startsWith("agent:") && !builtinAgent(key.slice(6)))
      .map((key) => key.slice(6)),
  ]
    .map((id) => parseAgentRecord(id, values[`agent:${id}`]))
    .filter((agent): agent is Agent => agent !== null);
}
