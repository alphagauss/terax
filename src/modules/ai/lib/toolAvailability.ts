/** 从工具自身配置解析通用可用性；未单独配置启停的工具默认可用。 */
import type { AgentToolId } from "./agentTools";
import { readWebProviders } from "@/modules/ai/web/settings";

export type ToolAvailability = Partial<Record<AgentToolId, boolean>>;

export function resolveToolAvailability(
  settings: Record<string, unknown>,
): ToolAvailability {
  const providers = readWebProviders(settings);
  return {
    web_search: providers.search !== "disabled",
    web_fetch: providers.fetch !== "disabled",
  };
}
