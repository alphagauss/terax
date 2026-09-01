/**
 * 本文件连接聊天 UI 与 Agent 流式运行时。
 * 系统提示词和工具白名单在 Chat runtime 内冻结，并复用每聊天 Subagent 协调器。
 */

import type { UIMessage } from "@ai-sdk/react";
import type { CustomEndpoint } from "../config";
import {
  getSubagentCoordinator,
  type SubagentResultEvent,
} from "../agents/subagentRuntime";
import type { SessionAgentSnapshot } from "./agents";
import { runAgentStream, type AgentUsageDelta } from "./agent";
import { formatAiError } from "./errors";
import type { ProviderKeys, CustomEndpointKeys } from "./keyring";
import {
  buildAgentSystemPrompt,
  type AgentExecutionEnvironment,
} from "./prompt";
import { readAgentsMd } from "./projectInstructions";
import type { ToolContext } from "../tools/tools";

type Deps = {
  getKeys: () => ProviderKeys;
  toolContext: ToolContext;
  getModelId: () => string;
  getDefaultSubagentModelId: () => string | null;
  getMaxConcurrentSubagents: () => number;
  getCustomInstructions: () => string;
  getAgent: () => SessionAgentSnapshot;
  getCwd: () => string;
  getEnvironment: () => AgentExecutionEnvironment;
  getLmstudioBaseURL?: () => string | undefined;
  getLmstudioModelId?: () => string | undefined;
  getMlxBaseURL?: () => string | undefined;
  getMlxModelId?: () => string | undefined;
  getOllamaBaseURL?: () => string | undefined;
  getOllamaModelId?: () => string | undefined;
  getOpenaiCompatibleBaseURL?: () => string | undefined;
  getOpenaiCompatibleModelId?: () => string | undefined;
  getOpenaiCompatibleContextLimit?: () => number | undefined;
  getOpenrouterModelId?: () => string | undefined;
  getCustomEndpoints?: () => readonly CustomEndpoint[];
  getCustomEndpointKeys?: () => CustomEndpointKeys;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  onSystemPrompt?: (
    systemPrompt: string,
    messages: UIMessage[],
  ) => void | Promise<void>;
  onCheckpoint: (
    completedMessages: UIMessage[],
    event: SubagentResultEvent,
  ) => void | Promise<void>;
};

type SendOptions = {
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
};

/**
 * 创建只从真实会话消息和固定会话环境构造请求的聊天传输层。
 *
 * 首次发送时读取 AGENTS.md，并冻结 cwd、执行环境、Agent 快照和自定义指令。
 * 后续发送复用同一个 Promise；Chat 被淘汰后自然丢弃并在下次创建时重建。
 */
export function createSessionTransport(deps: Deps) {
  let runtimeTask: Promise<{
    systemPrompt: string;
    agent: SessionAgentSnapshot;
  }> | null = null;

  /** 首次调用冻结 Agent 并构造系统提示，后续调用复用同一运行配置。 */
  const getRuntime = () => {
    if (runtimeTask) return runtimeTask;
    const cwd = deps.getCwd();
    const environment = deps.getEnvironment();
    const agent = deps.getAgent();
    const customInstructions = deps.getCustomInstructions();
    runtimeTask = readAgentsMd(cwd).then((projectInstructions) => ({
      agent,
      systemPrompt: buildAgentSystemPrompt({
        cwd,
        environment,
        agent,
        customInstructions,
        projectInstructions,
      }),
    }));
    return runtimeTask;
  };

  const run = async (options: SendOptions) => {
    const { systemPrompt, agent } = await getRuntime();
    const result = await runAgentStream({
      keys: deps.getKeys(),
      modelId: deps.getModelId(),
      defaultSubagentModelId: deps.getDefaultSubagentModelId(),
      maxConcurrentSubagents: deps.getMaxConcurrentSubagents(),
      subagentCoordinator: getSubagentCoordinator(
        deps.toolContext.getSessionId(),
      ),
      systemPrompt,
      allowedTools: agent.tools,
      toolContext: deps.toolContext,
      onStep: deps.onStep,
      onUsage: deps.onUsage,
      onCompact: deps.onCompact,
      onFinishMeta: deps.onFinishMeta,
      onSystemPrompt: deps.onSystemPrompt,
      onCheckpoint: deps.onCheckpoint,
      lmstudioBaseURL: deps.getLmstudioBaseURL?.(),
      lmstudioModelId: deps.getLmstudioModelId?.(),
      mlxBaseURL: deps.getMlxBaseURL?.(),
      mlxModelId: deps.getMlxModelId?.(),
      ollamaBaseURL: deps.getOllamaBaseURL?.(),
      ollamaModelId: deps.getOllamaModelId?.(),
      openaiCompatibleBaseURL: deps.getOpenaiCompatibleBaseURL?.(),
      openaiCompatibleModelId: deps.getOpenaiCompatibleModelId?.(),
      openaiCompatibleContextLimit: deps.getOpenaiCompatibleContextLimit?.(),
      openrouterModelId: deps.getOpenrouterModelId?.(),
      customEndpoints: deps.getCustomEndpoints?.(),
      customEndpointKeys: deps.getCustomEndpointKeys?.(),
      uiMessages: options.messages,
      abortSignal: options.abortSignal,
    });
    return result.toUIMessageStream({
      originalMessages: options.messages,
      onError: formatAiError,
    });
  };

  return {
    sendMessages: run,
    async reconnectToStream(): Promise<null> {
      return null;
    },
  };
}
