/**
 * 本文件构造会话级稳定系统提示和发送给模型的消息序列。
 * 执行环境、目录和指令只在会话首次请求时冻结，不持有 UI 或审批状态。
 */

import type { ModelMessage, SystemModelMessage } from "ai";
import type { HostPlatform } from "@/lib/platform";
import { SYSTEM_PROMPT, type ProviderId } from "@/modules/ai/config";
import type { WorkspaceEnv } from "@/modules/workspace";

export type AgentExecutionEnvironment = {
  platform: "Windows" | "macOS" | "Linux" | "Unknown";
  workspace: "Local" | "WSL" | "SSH";
  defaultShell: "PowerShell" | "Bash" | "System default";
};

type BuildAgentSystemPromptOptions = {
  cwd: string;
  environment: AgentExecutionEnvironment;
  agent: { name: string; instructions: string };
  customInstructions: string | undefined;
  projectInstructions: string | null;
};

export type PreparedAgentPrompt = {
  system: SystemModelMessage[];
  messages: ModelMessage[];
};

/**
 * 将宿主平台与不可变 Workspace 后端转换为模型真正执行命令的环境。
 * WSL 与 SSH 命令运行在 Linux，而不是宿主 Windows 或本地机器。
 */
export function resolveAgentExecutionEnvironment(
  workspace: WorkspaceEnv,
  hostPlatform: HostPlatform,
): AgentExecutionEnvironment {
  if (workspace.kind === "wsl") {
    return { platform: "Linux", workspace: "WSL", defaultShell: "Bash" };
  }
  if (workspace.kind === "ssh") {
    return { platform: "Linux", workspace: "SSH", defaultShell: "Bash" };
  }
  if (hostPlatform === "windows") {
    return {
      platform: "Windows",
      workspace: "Local",
      defaultShell: "PowerShell",
    };
  }
  if (hostPlatform === "macos") {
    return { platform: "macOS", workspace: "Local", defaultShell: "Bash" };
  }
  if (hostPlatform === "linux") {
    return { platform: "Linux", workspace: "Local", defaultShell: "Bash" };
  }
  return {
    platform: "Unknown",
    workspace: "Local",
    defaultShell: "System default",
  };
}

/**
 * 构造会话首次请求后保持不变的完整系统提示词。
 * 环境块使用受控枚举，并将工作目录编码为 JSON string，避免特殊路径改变提示结构。
 */
export function buildAgentSystemPrompt({
  cwd,
  environment,
  agent,
  customInstructions,
  projectInstructions,
}: BuildAgentSystemPromptOptions): string {
  const executionEnvironment =
    environment.workspace === "Local"
      ? `${environment.platform} Local`
      : environment.workspace === "WSL"
        ? `${environment.platform} via WSL`
        : `${environment.platform} over SSH`;
  const environmentBlock = `## SESSION ENVIRONMENT
Execution environment: ${executionEnvironment}
Shell tool default: ${environment.defaultShell}
Working directory: ${JSON.stringify(cwd)}
Relative paths passed to tools resolve from this directory. Use the default shell's syntax unless shell_exec explicitly selects another shell. Terminal scrollback is not included automatically; use get_terminal_output when it is relevant. This environment is fixed for the session.`;
  const normalizedProject = normalizeInstructions(projectInstructions);
  const normalizedAgent = normalizeInstructions(agent.instructions);
  const normalizedCustom = normalizeInstructions(customInstructions);
  const instructionsBlock = normalizedProject
    ? `\n\n## PROJECT INSTRUCTIONS: AGENTS.md\n${normalizedProject}`
    : "";
  const agentBlock = normalizedAgent
    ? `\n\n## AGENT INSTRUCTIONS: ${agent.name.replace(/[\r\n]+/g, " ").trim()}\n${normalizedAgent}`
    : "";
  const customBlock = normalizedCustom
    ? `\n\n## USER CUSTOM INSTRUCTIONS\nFollow these unless they conflict with higher-priority safety rules.\n${normalizedCustom}`
    : "";
  return `${SYSTEM_PROMPT}\n\n${environmentBlock}${instructionsBlock}${agentBlock}${customBlock}`;
}

/** 统一指令文本换行并忽略无语义的首尾空白，避免产生偶发的 prompt 差异。 */
function normalizeInstructions(value: string | null | undefined): string {
  return value?.replace(/\r\n?/g, "\n").trim() ?? "";
}

/** 将冻结的系统提示与会话历史转换为 provider 可缓存的模型输入。 */
export function prepareAgentPrompt(
  stableSystem: string,
  history: readonly ModelMessage[],
  provider: ProviderId,
): PreparedAgentPrompt {
  const system: SystemModelMessage[] = [
    { role: "system", content: stableSystem },
  ];
  const messages = history.slice();
  if (provider !== "anthropic") return { system, messages };

  system[0] = withAnthropicCacheMarker(system[0]);
  const lastIdx = messages.length - 1;
  if (lastIdx >= 0) {
    messages[lastIdx] = withAnthropicCacheMarker(messages[lastIdx]);
  }
  return { system, messages };
}

/** 为 Anthropic 消息添加短期缓存断点，同时保留其他 provider option。 */
function withAnthropicCacheMarker<T extends ModelMessage>(message: T): T {
  return {
    ...message,
    providerOptions: {
      ...(message.providerOptions ?? {}),
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  };
}
