/** 进程内智能体配置缓存，只在首次读取或宿主明确发布配置变更时更新。 */
import { invokeNative } from "@/lib/nativeHost";
import { resolveAgentRecords, type Agent } from "./agentDefinition";
import {
  resolveToolAvailability,
  type ToolAvailability,
} from "./toolAvailability";

export type AgentConfiguration = Agent & { revision: number };
let revision = 0;
let configurations: Map<string, AgentConfiguration> | undefined;
let loading: Promise<void> | undefined;
let availability = resolveToolAvailability({});
const listeners = new Set<() => void>();

export const getToolAvailability = () => availability;
export function subscribeToolAvailability(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 保存或共享存储刷新后发布配置；描述和图标变化不使运行提示词失效。 */
export function publishAgentConfigurations(
  agents: readonly Agent[],
  nextAvailability: ToolAvailability = availability,
): void {
  const availabilityChanged =
    JSON.stringify(availability) !== JSON.stringify(nextAvailability);
  if (availabilityChanged) availability = { ...nextAvailability };
  const next = new Map<string, AgentConfiguration>();
  for (const agent of agents) {
    const tools = agent.tools.filter((id) => availability[id] !== false);
    const previous = configurations?.get(agent.id);
    const unchanged =
      previous &&
      previous.name === agent.name &&
      previous.instructions.replace(/\r\n?/g, "\n").trim() ===
        agent.instructions.replace(/\r\n?/g, "\n").trim() &&
      JSON.stringify(previous.tools) === JSON.stringify(tools) &&
      JSON.stringify(previous.workspaceFiles) ===
        JSON.stringify(agent.workspaceFiles);
    next.set(agent.id, {
      ...agent,
      tools,
      workspaceFiles: [...agent.workspaceFiles],
      revision: unchanged ? previous.revision : ++revision,
    });
  }
  configurations = next;
  if (availabilityChanged) for (const listener of listeners) listener();
}

/** 新轮只读取内存版本，首次并发请求共享一次加载；失败允许下次重试。 */
export async function readAgentConfiguration(
  id: string,
): Promise<AgentConfiguration> {
  if (!configurations) {
    loading ??= Promise.all([
      invokeNative<Record<string, unknown>>("shared_store_read", {
        store: "ai-agents",
      }),
      invokeNative<Record<string, unknown>>("shared_store_read", {
        store: "settings",
      }),
    ])
      .then(([values, settings]) => {
        // 等待磁盘期间宿主可能已经发布更新，不能用旧读取覆盖它。
        if (!configurations)
          publishAgentConfigurations(
            resolveAgentRecords(values),
            resolveToolAvailability(settings),
          );
      })
      .finally(() => {
        loading = undefined;
      });
    await loading;
  }
  const agent = configurations?.get(id);
  if (!agent) throw new Error(`Agent configuration is unavailable: ${id}`);
  return agent;
}
