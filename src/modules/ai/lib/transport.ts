/**
 * 本文件连接会话请求与 Agent 流式运行时。
 * 系统提示词和工具白名单在 Chat runtime 内冻结，并转发每聊天 Subagent 展示状态。
 */

import type { SubagentDisplayState } from "@/modules/ai/agents/subagentDisplay";
import { getAgentTurnCoordinator } from "@/modules/ai/agents/subagentRuntime";
import type {
  ModelRef,
  ProviderBaseURLs,
  ProviderInstance,
  ProviderModels,
} from "@/modules/ai/config";
import type {
  ExternalAgentBinding,
  ExternalAgentId,
} from "@/modules/ai/external-agents/runtime";
import { type AgentUsageDelta, runAgentStream } from "@/modules/ai/lib/agent";
import type { SessionAgentSnapshot } from "@/modules/ai/lib/agents";
import type { TurnEvent } from "@/modules/ai/lib/conversation";
import { formatAiError } from "@/modules/ai/lib/errors";
import type {
  ProviderInstanceKeys,
  ProviderKeys,
} from "@/modules/ai/lib/keyring";
import { readAgentsMd } from "@/modules/ai/lib/projectInstructions";
import {
  type AgentExecutionEnvironment,
  buildAgentSystemPrompt,
} from "@/modules/ai/lib/prompt";
import type { ToolContext } from "@/modules/ai/tools/tools";
import type { UIMessage } from "@ai-sdk/react";

export type SessionTransportDependencies = {
  getKeys: () => ProviderKeys;
  toolContext: ToolContext;
  getModel: () => ModelRef;
  getDefaultSubagentModel: () => ModelRef | null;
  getMaxConcurrentSubagents: () => number;
  getCustomInstructions: () => string;
  getAgent: () => SessionAgentSnapshot;
  getCwd: () => string;
  getEnvironment: () => AgentExecutionEnvironment;
  getExternalAgent?: () => ExternalAgentBinding | null;
  getPermissionMode?: () => "ask" | "full-access";
  getProviderBaseURLs?: () => Readonly<ProviderBaseURLs>;
  getProviderModels?: () => Readonly<ProviderModels>;
  getCustomProviders?: () => readonly ProviderInstance[];
  getProviderInstanceKeys?: () => ProviderInstanceKeys;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  onSubagentDisplay?: (state: SubagentDisplayState) => void;
  onSystemPrompt?: (
    systemPrompt: string,
    messages: UIMessage[],
  ) => void | Promise<void>;
  onCheckpoint: (
    completedMessages: UIMessage[],
    event: TurnEvent,
  ) => void | Promise<void>;
  onExternalSession?: (
    agentId: ExternalAgentId,
    sessionId: string,
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
export function createSessionTransport(deps: SessionTransportDependencies) {
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
    const externalAgent = deps.getExternalAgent?.() ?? null;
    if (externalAgent) {
      const { runExternalAgentStream } = await import(
        "@/modules/ai/external-agents/runtime"
      );
      await deps.onSystemPrompt?.("", options.messages);
      return runExternalAgentStream({
        agentId: externalAgent.agentId,
        ownerSessionId: deps.toolContext.getSessionId(),
        externalSessionId: externalAgent.sessionId,
        cwd: deps.getCwd(),
        permissionMode: deps.getPermissionMode?.() ?? "ask",
        messages: options.messages,
        abortSignal: options.abortSignal,
        onSession: (sessionId) =>
          deps.onExternalSession?.(externalAgent.agentId, sessionId),
        onUsage: (usage) =>
          deps.onUsage?.({
            inputTokens: usage.input,
            outputTokens: usage.output,
            cachedInputTokens: usage.cached,
            lastInputTokens: usage.input,
            lastCachedTokens: usage.cached,
          }),
      });
    }
    const { systemPrompt, agent } = await getRuntime();
    const result = await runAgentStream({
      keys: deps.getKeys(),
      model: deps.getModel(),
      defaultSubagentModel: deps.getDefaultSubagentModel(),
      maxConcurrentSubagents: deps.getMaxConcurrentSubagents(),
      turnCoordinator: getAgentTurnCoordinator(deps.toolContext.getSessionId()),
      systemPrompt,
      allowedTools: agent.tools,
      toolContext: deps.toolContext,
      onStep: deps.onStep,
      onUsage: deps.onUsage,
      onCompact: deps.onCompact,
      onFinishMeta: deps.onFinishMeta,
      onSubagentDisplay: deps.onSubagentDisplay,
      onSystemPrompt: deps.onSystemPrompt,
      onCheckpoint: deps.onCheckpoint,
      providerBaseURLs: deps.getProviderBaseURLs?.(),
      providerModels: deps.getProviderModels?.(),
      customProviders: deps.getCustomProviders?.(),
      providerInstanceKeys: deps.getProviderInstanceKeys?.(),
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
