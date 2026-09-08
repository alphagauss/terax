/**
 * 本文件构造每轮稳定系统提示和发送给模型的消息序列。
 * 执行环境和目录属于会话，指令在每轮开始时冻结，不持有 UI 或审批状态。
 */

import type { ModelMessage, SystemModelMessage } from "ai";
import type { HostPlatform } from "@/lib/platform";
import type { ProviderId } from "@/modules/ai/config";
import type { WorkspaceEnv } from "@/modules/workspace";

import CORE_PROMPT from "@/modules/ai/prompts/core";
import type { WorkspaceInstruction } from "./projectInstructions";

export const PROMPT_SECTION_ORDER = [
  "core",
  "environment",
  "workspace",
  "agent",
  "custom",
] as const;
export type PromptSectionKind = (typeof PROMPT_SECTION_ORDER)[number];
export type PromptSection = { kind: PromptSectionKind; content: string };

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
  projectInstructions: readonly WorkspaceInstruction[];
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
 * 构造一轮内保持不变的系统提示词分段。
 * 环境块使用受控枚举，并将工作目录编码为 JSON string，避免特殊路径改变提示结构。
 */
export function buildAgentPromptSections({
  cwd,
  environment,
  agent,
  customInstructions,
  projectInstructions,
}: BuildAgentSystemPromptOptions): PromptSection[] {
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
Relative paths passed to tools resolve from this directory. Use the default shell's syntax unless shell_exec explicitly selects another shell. This environment is fixed for the session.`;
  return composeAgentPromptSections({
    environment: environmentBlock,
    workspace: projectInstructions.map(({ path, content }) =>
      instructionBlock(`PROJECT INSTRUCTIONS: ${path}`, content),
    ),
    agent,
    customInstructions,
  });
}

/** 配置页与运行时共用顺序及静态段；配置页为动态内容传入明确的说明。 */
export function composeAgentPromptSections(options: {
  environment: string;
  workspace: string[];
  agent: { name: string; instructions: string };
  customInstructions: string | undefined;
}): PromptSection[] {
  const blocks: Record<PromptSectionKind, string[]> = {
    core: [normalizeInstructions(CORE_PROMPT)],
    environment: [options.environment],
    workspace: options.workspace,
    agent: [
      instructionBlock(
        `AGENT INSTRUCTIONS: ${options.agent.name}`,
        options.agent.instructions,
      ),
    ],
    custom: [
      normalizeInstructions(options.customInstructions)
        ? `## USER CUSTOM INSTRUCTIONS\nFollow these unless they conflict with higher-priority safety rules.\n${normalizeInstructions(options.customInstructions)}`
        : "",
    ],
  };
  return PROMPT_SECTION_ORDER.flatMap((kind) =>
    blocks[kind].map((content) => ({ kind, content })),
  );
}

function instructionBlock(title: string, content: string): string {
  const normalized = normalizeInstructions(content);
  return normalized
    ? `## ${title.replace(/[\r\n]+/g, " ").trim()}\n${normalized}`
    : "";
}

/** 将有序分段拼成模型实际使用的完整系统提示。 */
export function buildAgentSystemPrompt(
  options: BuildAgentSystemPromptOptions,
): string {
  return buildAgentPromptSections(options)
    .map((section) => section.content)
    .filter(Boolean)
    .join("\n\n");
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
