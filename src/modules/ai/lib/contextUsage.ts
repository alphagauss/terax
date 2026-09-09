/** 每次模型请求前管理上下文预算，模型响应完成或中止时记录用量；不依赖展示生命周期。 */

import { CONTEXT_BUDGET_ERROR } from "@/modules/ai/lib/errors";
import type { ModelRef } from "@/modules/ai/config";
import {
  compactModelMessagesDetailed,
  estimateMessageTokens,
} from "@/modules/ai/lib/compact";
import { estimateTokens, normalizeUsage } from "@/modules/ai/lib/usage";
import { recordUsage, usageRecords } from "@/modules/ai/lib/usageRuntime";
import {
  asSchema,
  type LanguageModelUsage,
  type LanguageModelCallEndEvent,
  type ModelMessage,
  type ToolSet,
} from "ai";

export async function createContextUsage(options: {
  sessionId: string;
  turnId: string;
  taskId?: string;
  model: ModelRef;
  contextWindow: number;
  instructions: unknown;
  tools?: ToolSet;
  onCompact?: (info: { droppedCount: number }) => void;
}) {
  const definitions = await Promise.all(
    Object.entries(options.tools ?? {}).map(async ([name, tool]) => ({
      name,
      description: tool.description,
      parameters: await asSchema(tool.inputSchema).jsonSchema,
    })),
  );
  const overheadText = JSON.stringify({
    instructions: options.instructions,
    tools: definitions,
  });
  const overhead = estimateTokens(overheadText);
  const overheadHash = await fingerprint(overheadText);
  const previous = [...usageRecords(options.sessionId)]
    .reverse()
    .find((record) => record.taskId === options.taskId);
  let restored =
    previous?.model.providerId === options.model.providerId &&
    previous.model.modelId === options.model.modelId &&
    !previous.estimated.includes("inputTokens") &&
    previous.context?.overheadHash === overheadHash
      ? previous
      : undefined;
  let baseline: { messages: string[]; input: number } | undefined;
  let pending:
    | {
        id: string;
        messages: ModelMessage[];
        input: number;
        outputChars: number;
        toolInputs: Map<string, number>;
        toolCalls: Set<string>;
        prefixHash: string;
      }
    | undefined;
  function estimate(messages: ModelMessage[]) {
    const serialized = messages.map((message) => JSON.stringify(message));
    if (
      baseline?.messages.every(
        (message, index) => serialized[index] === message,
      )
    ) {
      return (
        baseline.input +
        estimateMessageTokens(messages.slice(baseline.messages.length))
      );
    }
    return overhead + estimateMessageTokens(messages);
  }
  function finish(
    usage?: LanguageModelUsage,
    content?: readonly { type: string; text?: string; input?: unknown }[],
    performance?: LanguageModelCallEndEvent["performance"],
  ) {
    if (!pending) return;
    if (content) {
      pending.outputChars = content.reduce(
        (sum, part) =>
          sum +
          (part.text?.length ??
            (part.type === "tool-call"
              ? JSON.stringify(part.input ?? {}).length
              : 0)),
        0,
      );
      pending.toolInputs.clear();
    }
    const normalized = normalizeUsage(
      usage,
      pending.input,
      Math.ceil(
        (pending.outputChars +
          [...pending.toolInputs.values()].reduce(
            (sum, count) => sum + count,
            0,
          )) *
          0.8,
      ),
    );
    recordUsage(options.sessionId, {
      id: pending.id,
      turnId: options.turnId,
      taskId: options.taskId,
      model: options.model,
      contextWindow: options.contextWindow,
      ...normalized,
      toolCalls: content
        ? content.filter((part) => part.type === "tool-call").length
        : pending.toolCalls.size,
      ...(performance
        ? {
            timing: {
              responseTimeMs: performance.responseTimeMs,
              timeToFirstOutputMs: performance.timeToFirstOutputMs,
            },
          }
        : {}),
      context: {
        overheadHash,
        prefixHash: pending.prefixHash,
        messageCount: pending.messages.length,
      },
    });
    if (!normalized.estimated.includes("inputTokens"))
      baseline = {
        messages: pending.messages.map((message) => JSON.stringify(message)),
        input: normalized.values.inputTokens,
      };
    pending = undefined;
  }
  return {
    async prepareStep({ messages }: { messages: ModelMessage[] }) {
      if (restored?.context) {
        const prefix = messages.slice(0, restored.context.messageCount);
        if (
          (await fingerprint(JSON.stringify(prefix))) ===
          restored.context.prefixHash
        )
          baseline = {
            messages: prefix.map((message) => JSON.stringify(message)),
            input: restored.values.inputTokens,
          };
        restored = undefined;
      }
      // 输入预算之外保留输出空间；粗估另留余量，不能把 0.8 系数当作硬上限。
      const budget = options.contextWindow * 0.8;
      const compact = compactModelMessagesDetailed(messages, budget, estimate);
      if (compact.compacted)
        options.onCompact?.({ droppedCount: compact.droppedCount });
      const input = estimate(compact.messages);
      if (input >= budget) throw new Error(CONTEXT_BUDGET_ERROR);
      pending = {
        id: crypto.randomUUID(),
        messages: compact.messages,
        input,
        outputChars: 0,
        toolInputs: new Map(),
        toolCalls: new Set(),
        prefixHash: await fingerprint(JSON.stringify(compact.messages)),
      };
      return { messages: compact.messages };
    },
    observe(chunk: {
      type: string;
      text?: string;
      delta?: string;
      id?: string;
      toolCallId?: string;
      input?: unknown;
    }) {
      if (!pending) return;
      if (chunk.type === "text-delta" || chunk.type === "reasoning-delta")
        pending.outputChars += (chunk.text ?? chunk.delta ?? "").length;
      if (chunk.type === "tool-input-delta" && chunk.id)
        pending.toolInputs.set(
          chunk.id,
          (pending.toolInputs.get(chunk.id) ?? 0) + (chunk.delta ?? "").length,
        );
      if (chunk.type === "tool-call" && chunk.toolCallId) {
        pending.toolCalls.add(chunk.toolCallId);
        pending.toolInputs.set(
          chunk.toolCallId,
          JSON.stringify(chunk.input ?? {}).length,
        );
      }
    },
    finish,
  };
}

/** 持久化摘要而不是请求正文；只有同模型、同指令和相同前缀才能复用实际输入基线。 */
async function fingerprint(text: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
