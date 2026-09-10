/**
 * 本文件通过用户已配置的模型请求编辑器行内补全。
 * 不推断模型能力，也不为缺失配置选择代码内默认模型。
 */

import { buildLanguageModel } from "@/modules/ai/lib/providerRuntime";
import type { ResolvedProviderConnection } from "@/modules/ai/providerRegistry";
import { generateText } from "ai";
import {
  buildParameterOptions,
  type ParameterAssignment,
} from "@/modules/ai/lib/modelParameters";
import {
  buildUserPrompt,
  COMPLETION_SYSTEM_PROMPT,
  type CompletionRequest,
} from "./prompt";

export type CompletionDeps = {
  connection: ResolvedProviderConnection | null;
  modelId: string;
  parameters?: ParameterAssignment[];
};

const MAX_OUTPUT_TOKENS = 1024;

export async function requestCompletion(
  req: CompletionRequest,
  deps: CompletionDeps,
  signal: AbortSignal,
): Promise<string> {
  const modelId = deps.modelId.trim();
  if (!modelId || !deps.connection) {
    throw new Error("No autocomplete model is configured.");
  }
  const model = await buildLanguageModel(deps.connection, modelId);

  const { text } = await generateText({
    model,
    instructions: COMPLETION_SYSTEM_PROMPT,
    prompt: buildUserPrompt(req),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...buildParameterOptions(
      deps.parameters ?? [],
      deps.connection.runtime.adapter,
      deps.connection.provider,
    ),
    maxRetries: 0,
    abortSignal: signal,
  });

  return cleanCompletion(text);
}

function cleanCompletion(raw: string): string {
  let t = raw;
  const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  if (fence) t = fence[1];
  t = t.replace(/^<\|cursor\|>/, "");
  return t;
}
