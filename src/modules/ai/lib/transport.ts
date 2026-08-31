/**
 * 本文件连接聊天 UI 与 Agent 流式运行时。
 * 会话消息保持原样发送，完整系统提示词在 Chat runtime 内只构造一次。
 */

import type { UIMessage } from "@ai-sdk/react";
import type { CustomEndpoint } from "../config";
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
  getCustomInstructions: () => string;
  getAgentPersona: () => { name: string; instructions: string } | null;
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
};

type SendOptions = {
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
};

/**
 * 创建只从真实会话消息和固定会话环境构造请求的聊天传输层。
 *
 * 首次发送时读取 AGENTS.md，并冻结 cwd、执行环境、人设和自定义指令。
 * 后续发送复用同一个 Promise；Chat 被淘汰后自然丢弃并在下次创建时重建。
 */
export function createSessionTransport(deps: Deps) {
  let systemPromptTask: Promise<string> | null = null;

  /** 首次调用构造系统提示，后续调用复用同一 Promise 和字符串。 */
  const getSystemPrompt = () => {
    if (systemPromptTask) return systemPromptTask;
    const cwd = deps.getCwd();
    const environment = deps.getEnvironment();
    const persona = deps.getAgentPersona();
    const customInstructions = deps.getCustomInstructions();
    systemPromptTask = readAgentsMd(cwd).then((projectInstructions) =>
      buildAgentSystemPrompt({
        cwd,
        environment,
        persona,
        customInstructions,
        projectInstructions,
      }),
    );
    return systemPromptTask;
  };

  const run = async (options: SendOptions) => {
    const systemPrompt = await getSystemPrompt();
    const result = await runAgentStream({
      keys: deps.getKeys(),
      modelId: deps.getModelId(),
      systemPrompt,
      toolContext: deps.toolContext,
      onStep: deps.onStep,
      onUsage: deps.onUsage,
      onCompact: deps.onCompact,
      onFinishMeta: deps.onFinishMeta,
      onSystemPrompt: deps.onSystemPrompt,
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
