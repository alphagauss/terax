/**
 * 本文件组合 AI 可调用的工具集合。
 * 所有文件与 Shell 相对路径由具体工具统一基于会话固定工作目录解析。
 */

import { buildManagedAgentTools } from "./agent";
import { buildEditTools } from "./edit";
import { buildFsTools } from "./fs";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSubagentTools } from "./subagent";
import { buildTerminalTools } from "./terminal";
import { buildTodoTools } from "./todo";

export { resolvePath, type ToolContext } from "./context";

/**
 * 构建当前会话的完整工具集合。
 *
 * 只读工具经过秘密路径拦截后自动执行，写入与命令工具必须取得用户批准。
 * 编辑工具额外要求模型先读取目标文件。各工具取得的 `getCwd` 始终指向
 * 会话首次发送时冻结的目录，不受标签页或 Explorer 后续切换影响。
 */
export function buildTools(ctx: import("./context").ToolContext) {
  return {
    ...buildFsTools(ctx),
    ...buildEditTools(ctx),
    ...buildSearchTools(ctx),
    ...buildShellTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildTerminalTools(ctx),
    ...buildTodoTools(ctx),
    ...buildManagedAgentTools(ctx),
  } as const;
}

export type ChatTools = ReturnType<typeof buildTools>;
