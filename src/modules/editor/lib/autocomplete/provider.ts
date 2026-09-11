/**
 * 本文件通过用户已配置的模型请求编辑器行内补全。
 * 不推断模型能力，也不为缺失配置选择代码内默认模型。
 */

import { createTextGenerationTask } from "@/modules/ai/lib/textGeneration";
import type { ResolvedProviderConnection } from "@/modules/ai/providerRegistry";
import type { ParameterAssignment } from "@/modules/ai/lib/modelParameters";
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

export async function requestCompletion(
  req: CompletionRequest,
  deps: CompletionDeps,
  signal: AbortSignal,
): Promise<string> {
  const modelId = deps.modelId.trim();
  if (!modelId || !deps.connection) {
    throw new Error("No autocomplete model is configured.");
  }
  const task = createTextGenerationTask(
    { ...deps, modelId, connection: deps.connection },
    {
      maxRetries: 0,
      signal,
    },
  );
  const text = await task.generate({
    instructions: COMPLETION_SYSTEM_PROMPT,
    prompt: buildUserPrompt(req),
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
