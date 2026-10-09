/** 模型调用用量事实与汇总。未知细分项不视作零，本地估算只补输入与可见输出。 */

import type { ModelRef } from "@/modules/ai/config";
import type { ModelMessage, LanguageModelUsage } from "ai";

type UsageField = "inputTokens" | "outputTokens";
type UsageValues = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
};
export type UsageRecord = {
  callId: string;
  turnId: string;
  taskId?: string;
  purpose?: "compaction";
  model: ModelRef;
  contextWindow: number;
  values: UsageValues;
  estimated: UsageField[];
  toolCalls: number;
  timing?: { responseTimeMs: number; timeToFirstOutputMs?: number };
  context?: { overheadHash: string; prefixHash: string; messageCount: number };
};

/** 中文场景的轻量估算；不是 tokenizer 或服务端计费上限。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.8);
}

export function normalizeUsage(
  usage: LanguageModelUsage | undefined,
  input: number,
  output: number,
): Pick<UsageRecord, "values" | "estimated"> {
  const values = {
    inputTokens: usage?.inputTokens,
    cacheReadTokens: usage?.inputTokenDetails.cacheReadTokens,
    outputTokens: usage?.outputTokens,
  };
  // SDK 的部分 adapter 会把缺失细分项补零；仅校验原始字段是否存在，数值换算仍交给 SDK。
  const raw = usage?.raw;
  if (
    raw &&
    [
      "prompt_tokens",
      "completion_tokens",
      "input_tokens",
      "output_tokens",
      "promptTokenCount",
      "candidatesTokenCount",
    ].some((key) => key in raw)
  ) {
    const has = (...paths: string[]) =>
      paths.some((path) => {
        let value: unknown = raw;
        for (const key of path.split("."))
          value =
            value && typeof value === "object"
              ? (value as Record<string, unknown>)[key]
              : undefined;
        return typeof value === "number";
      });
    if (
      values.inputTokens === 0 &&
      !has("prompt_tokens", "input_tokens", "promptTokenCount")
    )
      values.inputTokens = undefined;
    if (
      values.outputTokens === 0 &&
      !has("completion_tokens", "output_tokens", "candidatesTokenCount")
    )
      values.outputTokens = undefined;
    if (
      values.cacheReadTokens === 0 &&
      !has(
        "prompt_tokens_details.cached_tokens",
        "input_tokens_details.cached_tokens",
        "cache_read_input_tokens",
        "cachedContentTokenCount",
        "prompt_cache_hit_tokens",
      )
    )
      values.cacheReadTokens = undefined;
  }

  const estimated = (["inputTokens", "outputTokens"] as const).filter(
    (field) => values[field] == null,
  );
  return {
    values: {
      ...values,
      inputTokens: values.inputTokens ?? input,
      outputTokens: values.outputTokens ?? output,
    },
    estimated,
  };
}

/** 只累计本轮输出与工具调用；上下文和缓存直接读取末次请求，不累计。 */
export function summarizeOutput(records: readonly UsageRecord[]) {
  return {
    outputTokens: records.length
      ? records.reduce((sum, record) => sum + record.values.outputTokens, 0)
      : undefined,
    estimated: records.some((record) =>
      record.estimated.includes("outputTokens"),
    ),
    toolCalls: records.length
      ? records.reduce((sum, record) => sum + record.toolCalls, 0)
      : undefined,
  };
}

/** 汇总会话内全部模型调用；缓存字段不完整时不把未知值当作未命中。 */
export function summarizeSessionUsage(records: readonly UsageRecord[]) {
  if (!records.length)
    return {
      cacheReadTokens: undefined,
      noCacheTokens: undefined,
      outputTokens: undefined,
      outputEstimated: false,
    };
  const inputTokens = records.reduce(
    (sum, record) => sum + record.values.inputTokens,
    0,
  );
  const cacheComplete = records.every(
    (record) =>
      record.values.cacheReadTokens != null &&
      !record.estimated.includes("inputTokens"),
  );
  const cacheReadTokens = cacheComplete
    ? records.reduce(
        (sum, record) => sum + (record.values.cacheReadTokens ?? 0),
        0,
      )
    : undefined;
  return {
    cacheReadTokens,
    noCacheTokens:
      cacheReadTokens == null ? undefined : inputTokens - cacheReadTokens,
    outputTokens: records.reduce(
      (sum, record) => sum + record.values.outputTokens,
      0,
    ),
    outputEstimated: records.some((record) =>
      record.estimated.includes("outputTokens"),
    ),
  };
}

/** 按同一轮或子任务聚合 SDK 指标，不自行计时，也不推测底层重试次数。 */
export function summarizePerformance(records: readonly UsageRecord[]) {
  const firstOutputMs = records
    .map((record) => record.timing?.timeToFirstOutputMs)
    .find((value) => value != null && Number.isFinite(value) && value >= 0);
  let tokens = 0;
  let durationMs = 0;
  let measured = 0;
  for (const record of records) {
    const timing = record.timing;
    const output = record.values.outputTokens;
    if (
      timing?.timeToFirstOutputMs == null ||
      record.estimated.includes("outputTokens")
    )
      continue;
    const duration = timing.responseTimeMs - timing.timeToFirstOutputMs;
    if (!Number.isFinite(duration) || duration <= 0) continue;
    tokens += output;
    durationMs += duration;
    measured++;
  }
  return {
    firstOutputMs,
    tokensPerSecond: durationMs > 0 ? (tokens * 1000) / durationMs : undefined,
    partial: measured > 0 && measured < records.length,
  };
}

/** 仅用于缺失用量的展示估算，不据此删除消息或拒绝请求。 */
export function estimateMessageTokens(
  messages: readonly ModelMessage[],
): number {
  if (!messages.length) return 0;
  return estimateTokens(
    JSON.stringify(messages, (_key, value) =>
      value &&
      typeof value === "object" &&
      (value.type === "image" || value.type === "file")
        ? { type: value.type }
        : value,
    ),
  );
}
