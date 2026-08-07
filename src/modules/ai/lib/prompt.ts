/**
 * 本文件构造发送给模型的系统提示和消息序列。
 * 只处理模型上下文，不持有 UI 模式或审批状态。
 */

import type { ModelMessage, SystemModelMessage } from "ai";
import type { ProviderId } from "@/modules/ai/config";

export type PreparedAgentPrompt = {
  system: SystemModelMessage[];
  messages: ModelMessage[];
};

export function prepareAgentPrompt(
  stableSystem: string,
  history: readonly ModelMessage[],
  provider: ProviderId,
): PreparedAgentPrompt {
  const system: SystemModelMessage[] = [
    { role: "system", content: stableSystem },
  ];
  const messages = history.slice();
  if (provider !== "anthropic") return { system, messages };

  system[0] = withAnthropicCacheMarker(system[0]);
  const lastIdx = messages.length - 1;
  if (lastIdx >= 0) {
    messages[lastIdx] = withAnthropicCacheMarker(messages[lastIdx]);
  }
  return { system, messages };
}

function withAnthropicCacheMarker<T extends ModelMessage>(message: T): T {
  return {
    ...message,
    providerOptions: {
      ...(message.providerOptions ?? {}),
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  };
}
