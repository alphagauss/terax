/**
 * 本文件连接聊天 UI 与 Agent 流式运行时。
 * 系统提示词和工具白名单在 Chat runtime 内冻结，并转发每聊天 Subagent 展示状态。
 */

import type { UIMessage } from "@ai-sdk/react";
import type { SubagentDisplayState } from "../agents/subagentDisplay";
import {
  getSubagentCoordinator,
  type SubagentResultEvent,
} from "../agents/subagentRuntime";
import type {
  ModelRef,
  ProviderBaseURLs,
  ProviderInstance,
  ProviderModels,
} from "../config";
import type { ToolContext } from "../tools/tools";
import { type AgentUsageDelta, runAgentStream } from "./agent";
import type { SessionAgentSnapshot } from "./agents";
import { formatAiError } from "./errors";
import type { ProviderInstanceKeys, ProviderKeys } from "./keyring";
import { readAgentsMd } from "./projectInstructions";
import {
  type AgentExecutionEnvironment,
  buildAgentSystemPrompt,
} from "./prompt";

type Deps = {
  getKeys: () => ProviderKeys;
  toolContext: ToolContext;
  getModel: () => ModelRef;
  getDefaultSubagentModel: () => ModelRef | null;
  getMaxConcurrentSubagents: () => number;
  getCustomInstructions: () => string;
  getAgent: () => SessionAgentSnapshot;
  getCwd: () => string;
  getEnvironment: () => AgentExecutionEnvironment;
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
      model: deps.getModel(),
      defaultSubagentModel: deps.getDefaultSubagentModel(),
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
