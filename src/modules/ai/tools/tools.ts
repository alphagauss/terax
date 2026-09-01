/**
 * 本文件组合 AI 可调用的工具集合。
 * 工具按会话白名单过滤，Subagent 协调能力只注入主 Agent 的运行请求。
 */

import { buildFsTools } from "./fs";
import { buildPatchTools } from "./patch";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSubagentTools, type SubagentStarter } from "./subagent";
import { buildTerminalTools } from "./terminal";
import {
  AGENT_TOOL_IDS,
  normalizeAgentTools,
  type AgentToolId,
} from "../lib/agentTools";

export { resolvePath, type ToolContext } from "./context";

/**
 * 构建当前会话被 Agent 快照允许的工具集合。
 *
 * 只读工具经过秘密路径拦截后自动执行，写入与命令工具必须取得用户批准。
 * 编辑工具额外要求模型先读取目标文件。各工具取得的 `getCwd` 始终指向
 * 会话首次发送时冻结的目录，不受标签页或 Explorer 后续切换影响。
 */
export function buildTools(
  ctx: import("./context").ToolContext,
  allowedTools: readonly AgentToolId[] = AGENT_TOOL_IDS,
  startSubagent?: SubagentStarter,
) {
  const all = {
    ...buildFsTools(ctx),
    ...buildPatchTools(ctx),
    ...buildSearchTools(ctx),
    ...buildShellTools(ctx),
    ...buildSubagentTools(startSubagent),
    ...buildTerminalTools(ctx),
  } as const;
  const allowed = new Set(normalizeAgentTools(allowedTools));
  return Object.fromEntries(
    AGENT_TOOL_IDS.filter((id) => allowed.has(id)).map((id) => [id, all[id]]),
  ) as Partial<typeof all>;
}

export type ChatTools = ReturnType<typeof buildTools>;
