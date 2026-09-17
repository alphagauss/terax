/**
 * 本文件连接会话请求与 Agent 流式运行时。
 * 系统提示词和工具白名单在每轮内冻结，并转发每聊天 Subagent 展示状态。
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
import { runAgentStream } from "@/modules/ai/lib/agent";
import type { ParameterAssignment } from "@/modules/ai/lib/modelParameters";
import type { AgentConfiguration } from "./agentConfiguration";
import type { TurnEvent } from "@/modules/ai/lib/conversation";
import { formatAiError } from "@/modules/ai/lib/errors";
import { coalesceStream } from "@/modules/ai/lib/coalesceStream";
import type {
  ProviderInstanceKeys,
  ProviderKeys,
} from "@/modules/ai/lib/keyring";
import { readWorkspaceInstructions } from "@/modules/ai/lib/projectInstructions";
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
  getMaxAgentSteps: () => number;
  getMaxSubagentSteps: () => number;
  getCustomInstructions: () => string;
  getAgent: () => AgentConfiguration | Promise<AgentConfiguration>;
  getTurnId: () => string;
  getCwd: () => string;
  getEnvironment: () => AgentExecutionEnvironment;
  getExternalAgent?: () => ExternalAgentBinding | null;
  getPermissionMode?: () => "ask" | "full-access";
  getProviderBaseURLs?: () => Readonly<ProviderBaseURLs>;
  getProviderModels?: () => Readonly<ProviderModels>;
  getCustomProviders?: () => readonly ProviderInstance[];
  getProviderInstanceKeys?: () => ProviderInstanceKeys;
  getModelParameters?: (
    model: ModelRef,
    subagent: boolean,
  ) => ParameterAssignment[];
  onModelSnapshot?: (snapshot: {
    model: ModelRef;
    parameters: ParameterAssignment[];
  }) => void;
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
 * 配置未变时复用完整运行配置，版本或全局指令变化后完整初始化提示词。
 * 初始化包含读取工作区文件；不监听文档，审批续跑保持本轮快照。
 */
export function createSessionTransport(deps: SessionTransportDependencies) {
  let modelTurnId: string | null = null;
  let modelSnapshot: {
    model: ModelRef;
    modelParameters: ParameterAssignment[];
    maxAgentSteps: number;
    maxSubagentSteps: number;
  } | null = null;
  let runtimeTask: Promise<{
    systemPrompt: string;
    agent: AgentConfiguration;
  }> | null = null;

  let runtimeTurnId: string | null = null;

  let prepared:
    | {
        customInstructions: string;
        systemPrompt: string;
        agent: AgentConfiguration;
      }
    | undefined;

  /** 同轮续跑保持快照；新轮比较内存版本，只在实际变化后重新组装。 */
  const getRuntime = () => {
    const turnId = deps.getTurnId();
    if (runtimeTask && runtimeTurnId === turnId) return runtimeTask;
    runtimeTurnId = turnId;
    const cwd = deps.getCwd();
    const environment = deps.getEnvironment();
    const customInstructions = deps
      .getCustomInstructions()
      .replace(/\r\n?/g, "\n")
      .trim();
    runtimeTask = Promise.resolve(deps.getAgent()).then(async (agent) => {
      if (
        prepared?.agent.revision === agent.revision &&
        prepared.customInstructions === customInstructions
      )
        return prepared;
      const projectInstructions = await readWorkspaceInstructions(
        cwd,
        agent.workspaceFiles,
      );
      prepared = {
        customInstructions,
        agent,
        systemPrompt: buildAgentSystemPrompt({
          cwd,
          environment,
          agent,
          customInstructions,
          projectInstructions,
        }),
      };
      return prepared;
    });
    return runtimeTask;
  };

  const run = async (options: SendOptions) => {
    const externalAgent = deps.getExternalAgent?.() ?? null;
    if (externalAgent) {
      const { runExternalAgentStream } = await import(
        "@/modules/ai/external-agents/runtime"
      );
      await deps.onSystemPrompt?.("", options.messages);
      return coalesceStream(
        await runExternalAgentStream({
          agentId: externalAgent.agentId,
          ownerSessionId: deps.toolContext.getSessionId(),
          externalSessionId: externalAgent.sessionId,
          cwd: deps.getCwd(),
          permissionMode: deps.getPermissionMode?.() ?? "ask",
          messages: options.messages,
          abortSignal: options.abortSignal,
          onSession: (sessionId) =>
            deps.onExternalSession?.(externalAgent.agentId, sessionId),
        }),
      );
    }
    // 在任何异步准备前冻结本轮模型与实际参数，同轮续跑不重新读取 UI。
    const turnId = deps.getTurnId();
    if (!modelSnapshot || modelTurnId !== turnId) {
      const model = deps.getModel();
      modelSnapshot = structuredClone({
        model,
        modelParameters: deps.getModelParameters?.(model, false) ?? [],
        maxAgentSteps: deps.getMaxAgentSteps(),
        maxSubagentSteps: deps.getMaxSubagentSteps(),
      });
      modelTurnId = turnId;
      deps.onModelSnapshot?.({
        model: modelSnapshot.model,
        parameters: modelSnapshot.modelParameters,
      });
    }
    const frozenModel = modelSnapshot;
    const { systemPrompt, agent } = await getRuntime();
    const result = await runAgentStream({
      keys: deps.getKeys(),
      model: frozenModel.model,
      modelParameters: frozenModel.modelParameters,
      maxAgentSteps: frozenModel.maxAgentSteps,
      maxSubagentSteps: frozenModel.maxSubagentSteps,
      getSubagentConfiguration: (parentModel) => {
        const model = deps.getDefaultSubagentModel() ?? parentModel;
        return {
          model,
          modelParameters: deps.getModelParameters?.(model, true) ?? [],
          keys: deps.getKeys(),
          providerBaseURLs: deps.getProviderBaseURLs?.(),
          providerModels: deps.getProviderModels?.(),
          customProviders: deps.getCustomProviders?.(),
          providerInstanceKeys: deps.getProviderInstanceKeys?.(),
        };
      },
      maxConcurrentSubagents: deps.getMaxConcurrentSubagents(),
      turnCoordinator: getAgentTurnCoordinator(deps.toolContext.getSessionId()),
      systemPrompt,
      allowedTools: agent.tools,
      toolContext: deps.toolContext,
      turnId,
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
