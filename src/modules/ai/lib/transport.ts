/**
 * 本文件连接聊天 UI 与 Agent 流式运行时。
 * 会话消息保持原样发送，项目指令和固定工作目录只进入系统提示词。
 */

import type { UIMessage } from "@ai-sdk/react";
import type { CustomEndpoint } from "../config";
import { runAgentStream, type AgentUsageDelta } from "./agent";
import { formatAiError } from "./errors";
import type { ProviderKeys, CustomEndpointKeys } from "./keyring";
import { readAgentsMd } from "./projectInstructions";
import type { ToolContext } from "../tools/tools";

type Deps = {
  getKeys: () => ProviderKeys;
  toolContext: ToolContext;
  getModelId: () => string;
  getCustomInstructions: () => string;
  getAgentPersona: () => { name: string; instructions: string } | null;
  getCwd: () => string;
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
 * 每次发送前从会话 cwd 读取 AGENTS.md，读取结果由底层短暂缓存。
 */
export function createSessionTransport(deps: Deps) {
  const run = async (options: SendOptions) => {
    const cwd = deps.getCwd();
    const projectInstructions = await readAgentsMd(cwd);
    const result = await runAgentStream({
      keys: deps.getKeys(),
      modelId: deps.getModelId(),
      customInstructions: deps.getCustomInstructions(),
      agentPersona: deps.getAgentPersona(),
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
      cwd,
      projectInstructions,
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
