/** 每次模型请求记录输入基线，完成或中止时保存用量；不裁剪或拦截请求，不依赖展示生命周期。 */

import type { ModelRef } from "@/modules/ai/config";
import {
  estimateMessageTokens,
  estimateTokens,
  normalizeUsage,
} from "@/modules/ai/lib/usage";
import { recordUsage, usageRecords } from "@/modules/ai/lib/usageRuntime";
import {
  asSchema,
  type LanguageModelCallEndEvent,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";

export async function createContextUsage(options: {
  sessionId: string;
  turnId: string;
  taskId?: string;
  runId?: string;
  model: ModelRef;
  contextWindow: number;
  instructions: unknown;
  tools?: ToolSet;
  purpose?: "compaction";
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
    .find(
      (record) =>
        record.taskId === options.taskId && record.purpose === options.purpose,
    );
  let restored =
    previous?.model.providerId === options.model.providerId &&
    previous.model.modelId === options.model.modelId &&
    !previous.estimated.includes("inputTokens") &&
    previous.context?.overheadHash === overheadHash
      ? previous
      : undefined;
  let baseline: { messages: string[]; input: number } | undefined;
  let callId: string | undefined;
  let pending:
    | {
        callId: string;
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
      callId: pending.callId,
      turnId: options.turnId,
      taskId: options.taskId,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.purpose ? { purpose: options.purpose } : {}),
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
    get callId() {
      return callId;
    },
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
      const input = estimate(messages);
      callId = crypto.randomUUID();
      pending = {
        callId,
        messages,
        input,
        outputChars: 0,
        toolInputs: new Map(),
        toolCalls: new Set(),
        prefixHash: await fingerprint(JSON.stringify(messages)),
      };
      return { messages };
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
