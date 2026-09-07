/**
 * 本文件定义固定主 Agent、自定义 Agent 及其会话快照。
 * 自定义定义跨 Workspace 共享，会话只依赖首次发送时保存的运行快照。
 */

import i18n from "@/i18n";
import { readSharedStore, setSharedStoreKey } from "@/lib/sharedStore";
import { invoke } from "@tauri-apps/api/core";
import { normalizeAgentTools } from "./agentTools";

export {
  MAIN_AGENT,
  MAIN_AGENT_ID,
  normalizeAgentIcon,
  findAgent,
  snapshotAgent,
  parseSessionAgent,
} from "@/modules/ai/lib/agentDefinition";
export type {
  Agent,
  AgentIconId,
  SessionAgentSnapshot,
} from "@/modules/ai/lib/agentDefinition";
import {
  MAIN_AGENT_ID,
  normalizeAgentIcon,
  type Agent,
} from "@/modules/ai/lib/agentDefinition";
const agentKey = (id: string) => `agent:${id}`;

/** 读取所有有效 Custom Agent，并在内存中迁移旧版缺失的工具列表。 */
export async function loadAgents(): Promise<Agent[]> {
  const values = await readSharedStore("ai-agents");
  return Object.entries(values)
    .filter(([key]) => key.startsWith("agent:"))
    .map(([key, value]) => parseCustomAgent(key, value))
    .filter((agent): agent is Agent => agent !== null);
}

/** 保存单个 Custom Agent，工具列表在写入前规范为稳定顺序。 */
export function upsertCustomAgent(agent: Agent): Promise<void> {
  const normalized = { ...agent, tools: normalizeAgentTools(agent.tools) };
  return setSharedStoreKey("ai-agents", agentKey(agent.id), normalized);
}

/**
 * 删除 Custom Agent 及其跨 Workspace 的全部会话。
 *
 * Rust 在共享 Agent 配置锁和关联会话锁内完成级联操作，并返回删除的会话 ID。
 */
export function deleteCustomAgent(id: string): Promise<string[]> {
  return invoke<string[]>("ai_agent_delete", { agentId: id });
}

/** 生成不与固定主 Agent 冲突的 Custom Agent 标识。 */
export function newAgentId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 解析 Agent 显示名称，固定主 Agent 支持运行时语言切换。 */
export function agentDisplayName(agent: Pick<Agent, "id" | "name">): string {
  return agent.id === MAIN_AGENT_ID
    ? i18n.t("aiAgents:name.main", { defaultValue: agent.name })
    : agent.name;
}

/** 解析 Agent 显示描述，Custom Agent 保留用户输入。 */
export function agentDisplayDescription(
  agent: Pick<Agent, "id" | "description">,
): string {
  return agent.id === MAIN_AGENT_ID
    ? i18n.t("aiAgents:desc.main", { defaultValue: agent.description })
    : agent.description;
}

/** 严格解析共享存储中的 Custom Agent，忽略损坏记录和保留 ID。 */
function parseCustomAgent(key: string, value: unknown): Agent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    record.id.startsWith("builtin:") ||
    key !== agentKey(record.id) ||
    typeof record.name !== "string" ||
    !record.name.trim() ||
    typeof record.description !== "string" ||
    typeof record.instructions !== "string" ||
    !record.instructions.trim()
  ) {
    return null;
  }
  const icon = normalizeAgentIcon(record.icon);
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    instructions: record.instructions,
    icon,
    tools: normalizeAgentTools(record.tools),
  };
}
