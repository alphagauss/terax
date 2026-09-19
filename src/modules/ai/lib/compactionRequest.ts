/** 单次非流式交接请求。保留模型前缀及工具定义，但绝不执行工具或进入 Agent 循环。 */
import i18n from "@/i18n";
import { generateText, type ModelMessage, type ToolSet } from "ai";
import {
  buildConfiguredLanguageModel,
  createProviderDownload,
} from "@/modules/ai/lib/providerRuntime";
import { buildParameterOptions } from "@/modules/ai/lib/modelParameters";
import { getProvider } from "@/modules/ai/providerRegistry";
import { getModelContextWindow, resolveModel } from "@/modules/ai/config";
import {
  prepareAgentPrompt,
  type PreparedAgentPrompt,
} from "@/modules/ai/lib/prompt";
import { createContextUsage } from "@/modules/ai/lib/contextUsage";
import type {
  RunAgentOptions,
  SubagentModelConfiguration,
} from "@/modules/ai/lib/agent";

export async function generateCompaction(options: {
  configuration: SubagentModelConfiguration;
  sessionId: string;
  turnId: string;
  systemPrompt: string;
  messages: ModelMessage[];
  cachedPrefix?: PreparedAgentPrompt;
  tools: ToolSet;
  instruction: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { configuration: config, signal } = options;
  signal?.throwIfAborted();
  const provider = resolveModel(config.model, config).provider;
  const model = await buildConfiguredLanguageModel(
    config.model,
    config.keys,
    config,
  );
  signal?.throwIfAborted();
  const tools: ToolSet = Object.fromEntries(
    Object.entries(options.tools).map(([name, definition]) => {
      const tool = { ...definition };
      delete tool.execute;
      delete tool.onInputStart;
      delete tool.onInputDelta;
      delete tool.onInputAvailable;
      return [name, tool];
    }),
  );
  const prompt = prepareAgentPrompt(
    options.systemPrompt,
    options.messages,
    provider,
  );
  // 保留原有缓存断点，压缩指令只追加到尾部。
  const messages: ModelMessage[] = [
    ...(options.cachedPrefix
      ? [
          ...options.cachedPrefix.messages,
          ...prompt.messages.slice(options.cachedPrefix.messages.length),
        ]
      : prompt.messages),
    { role: "user", content: options.instruction },
  ];
  const usage = await createContextUsage({
    sessionId: options.sessionId,
    turnId: options.turnId,
    model: config.model,
    contextWindow: getModelContextWindow(
      config.model,
      config.providerModels ?? {},
    ),
    instructions: prompt.instructions,
    tools,
    purpose: "compaction",
  });
  try {
    const result = await generateText({
      ...buildParameterOptions(
        config.modelParameters ?? [],
        getProvider(provider).runtime.adapter,
        provider,
      ),
      model,
      instructions: prompt.instructions,
      messages,
      tools,
      prepareStep: usage.prepareStep,
      experimental_download: createProviderDownload(
        config.model.providerId,
        signal,
      ),
      abortSignal: signal,
      maxRetries: 0,
      onLanguageModelCallEnd: (event) =>
        usage.finish(event.usage, event.content, event.performance),
    });
    signal?.throwIfAborted();
    if (
      result.toolCalls.length ||
      result.finishReason !== "stop" ||
      !result.text.trim()
    )
      throw new Error(i18n.t("ai:chat.compactionFailed"));
    return result.text.trim();
  } finally {
    usage.finish();
  }
}

/** 默认完整继承父请求配置，显式覆盖在请求发起时冻结。 */
export function compactionConfiguration(
  opts: RunAgentOptions,
): SubagentModelConfiguration {
  return structuredClone(
    opts.getCompactionConfiguration?.(
      opts.model,
      opts.modelParameters ?? [],
    ) ?? {
      model: opts.model,
      modelParameters: opts.modelParameters,
      keys: opts.keys,
      providerBaseURLs: opts.providerBaseURLs,
      providerModels: opts.providerModels,
      customProviders: opts.customProviders,
      providerInstanceKeys: opts.providerInstanceKeys,
    },
  );
}
