/**
 * 本文件持久化内置与自定义智能体配置。
 * 所有定义跨 Workspace 共享，配置按智能体记录精确写入。
 */

import { publishAgentConfigurations } from "./agentConfiguration";
import { resolveToolAvailability } from "./toolAvailability";
import i18n from "@/i18n";
import { readSharedStore, setSharedStoreKey } from "@/lib/sharedStore";
import { invoke } from "@tauri-apps/api/core";

export {
  MAIN_AGENT,
  MAIN_AGENT_ID,
  CHANNEL_AGENT,
  CHANNEL_AGENT_ID,
  BUILTIN_AGENTS,
  builtinAgent,
  normalizeAgentIcon,
  findAgent,
  snapshotAgent,
  parseSessionAgent,
  parseWorkspaceFiles,
} from "@/modules/ai/lib/agentDefinition";
export type {
  Agent,
  AgentIconId,
  SessionAgentSnapshot,
} from "@/modules/ai/lib/agentDefinition";
import {
  builtinAgent,
  resolveAgentRecords,
  parseAgentRecord,
  type Agent,
} from "@/modules/ai/lib/agentDefinition";
const agentKey = (id: string) => `agent:${id}`;

let loadingAgents: Promise<Agent[]> | undefined;

/** 串行读取并发布配置，避免保存与共享存储刷新交错时旧读取覆盖新值。 */
export function loadAgents(): Promise<Agent[]> {
  const load = async () => {
    const values = await readSharedStore("ai-agents");
    const settings = await readSharedStore("settings");
    const agents = resolveAgentRecords(values);
    publishAgentConfigurations(agents, resolveToolAvailability(settings));
    return agents;
  };
  loadingAgents = loadingAgents ? loadingAgents.then(load, load) : load();
  return loadingAgents;
}

/** 保存单条配置；内置字段等于默认值时不持久化覆盖，空提示词仍是有效覆盖。 */
export async function saveAgent(agent: Agent): Promise<void> {
  const normalized = parseAgentRecord(agent.id, agent);
  if (!normalized) throw new Error("Invalid agent configuration");
  const defaults = builtinAgent(agent.id);
  const value: Record<string, unknown> = defaults ? {} : { ...normalized };
  if (defaults) {
    for (const key of ["instructions", "tools", "workspaceFiles"] as const) {
      if (JSON.stringify(normalized[key]) !== JSON.stringify(defaults[key]))
        value[key] = normalized[key];
    }
  }
  await setSharedStoreKey("ai-agents", agentKey(agent.id), value);
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

/** 内置名称与说明按界面语言显示，自定义文本保持用户输入。 */
export function agentDisplayName(agent: Pick<Agent, "id" | "name">): string {
  return builtinAgent(agent.id)
    ? i18n.t(`aiAgents:name.${agent.id.slice(8)}`, { defaultValue: agent.name })
    : agent.name;
}

export function agentDisplayDescription(
  agent: Pick<Agent, "id" | "description">,
): string {
  return builtinAgent(agent.id)
    ? i18n.t(`aiAgents:desc.${agent.id.slice(8)}`, {
        defaultValue: agent.description,
      })
    : agent.description;
}
