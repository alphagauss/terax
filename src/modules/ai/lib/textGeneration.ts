/**
 * 为补全、提交信息等直接生成任务提供模型请求入口。
 * 创建任务时冻结连接与参数；同一任务的修复请求复用模型，不拥有业务提示词或历史。
 * 当前提供非流式文本生成，不承担 Agent 编排，也尚未接入用量记录。
 */
import { generateText } from "ai";
import { buildLanguageModel } from "@/modules/ai/lib/providerRuntime";
import {
  buildParameterOptions,
  type ParameterAssignment,
} from "@/modules/ai/lib/modelParameters";
import type { ResolvedProviderConnection } from "@/modules/ai/providerRegistry";

export type TextGenerationConfiguration = {
  connection: ResolvedProviderConnection;
  modelId: string;
  parameters?: readonly ParameterAssignment[];
};

/** 同步冻结任务配置，首次请求才创建 SDK 模型；取消信号贯穿所有请求。 */
export function createTextGenerationTask(
  configuration: TextGenerationConfiguration,
  options: {
    maxRetries?: number;
    signal?: AbortSignal;
  } = {},
) {
  const config = structuredClone(configuration);
  const { maxRetries, signal } = options;
  let model: ReturnType<typeof buildLanguageModel> | undefined;
  return {
    async generate({
      instructions,
      prompt,
    }: {
      instructions: string;
      prompt: string;
    }): Promise<string> {
      signal?.throwIfAborted();
      model ??= buildLanguageModel(config.connection, config.modelId);
      const languageModel = await model;
      signal?.throwIfAborted();
      const result = await generateText({
        model: languageModel,
        instructions,
        prompt,
        ...buildParameterOptions(
          config.parameters ?? [],
          config.connection.runtime.adapter,
          config.connection.provider,
        ),
        maxRetries,
        abortSignal: signal,
      });
      return result.text;
    },
  };
}
