/**
 * 定义模型的枚举请求参数、默认选择及 API 字段到 SDK 选项的转换。
 * 不猜测模型能力；显式选择省略时不发送，扩展字段只做明确的协议映射。
 */
import type { JSONValue } from "ai";
import type { RuntimeAdapterId } from "@/modules/ai/providerRegistry";

export type ParameterValue = string | number | boolean | null;
export type ParameterSelections = Record<string, string>;
export type ModelParameter = {
  id: string;
  label: string;
  target: "standard" | "provider";
  path: string;
  valueType: "string" | "number" | "boolean";
  options: {
    id: string;
    label: string;
    value: ParameterValue;
    omit?: boolean;
  }[];
  defaultOption: string | null;
  showInSummary: boolean;
};
export type ParameterAssignment = Pick<ModelParameter, "target" | "path"> & {
  value: ParameterValue;
};
export type ModelParameterDefinitions = Record<string, ModelParameter[]>;
export type ModelParameterSelections = Record<string, ParameterSelections>;

/** 字符串编辑框中的 null 表示显式 JSON 空值，与省略整个参数无关。 */
export function parseParameterValue(
  type: ModelParameter["valueType"],
  input: string,
): ParameterValue {
  if (type === "number") return Number(input);
  if (type === "boolean") return input === "true";
  return input.trim() === "null" ? null : input;
}

const STANDARD_FIELDS = {
  temperature: "temperature",
  top_p: "topP",
  max_tokens: "maxOutputTokens",
  max_output_tokens: "maxOutputTokens",
  presence_penalty: "presencePenalty",
  frequency_penalty: "frequencyPenalty",
  seed: "seed",
} as const;
export const STANDARD_PARAMETER_PATHS = Object.keys(STANDARD_FIELDS);
const RESERVED = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "model",
  "messages",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "stream_options",
]);

/** 返回可定位的配置错误，路径重叠会造成对象覆盖，保存前必须拒绝。 */
export function validateModelParameters(
  parameters: readonly ModelParameter[],
  adapter?: RuntimeAdapterId,
): string | null {
  // 保存与读取使用相同的结构校验，再额外检查当前 SDK 转换后的路径。
  if (adapter) {
    const invalid = validateModelParameters(parameters);
    if (invalid) return invalid;
  }
  const ids = new Set<string>();
  const paths: string[] = [];
  for (const p of parameters) {
    if (!p.id || ids.has(p.id) || !p.label.trim()) return "invalidDefinition";
    ids.add(p.id);
    const parts = p.path.split(".");
    if (
      parts.some(
        (part) => !/^[a-z][a-z0-9_]*$/.test(part) || RESERVED.has(part),
      )
    )
      return "invalidPath";
    if (p.target !== "standard" && p.target !== "provider")
      return "invalidDefinition";
    if (
      p.target === "standard" &&
      (!STANDARD_PARAMETER_PATHS.includes(p.path) || p.valueType !== "number")
    )
      return "invalidStandard";
    if (p.target === "provider" && STANDARD_PARAMETER_PATHS.includes(p.path))
      return "useStandard";
    const path = `${p.target}.${p.target === "standard" ? STANDARD_FIELDS[p.path as keyof typeof STANDARD_FIELDS] : adapter ? providerParameterPath(p.path, adapter) : p.path}`;
    if (
      paths.some(
        (other) =>
          other === path ||
          other.startsWith(`${path}.`) ||
          path.startsWith(`${other}.`),
      )
    )
      return "duplicatePath";
    paths.push(path);
    if (
      !["string", "number", "boolean"].includes(p.valueType) ||
      !p.options.length
    )
      return "invalidOptions";
    const options = new Set<string>();
    let hasOmit = false;
    for (const o of p.options) {
      if (!o.id || options.has(o.id) || !o.label.trim())
        return "invalidOptions";
      options.add(o.id);
      if (o.omit === true) {
        if (hasOmit) return "duplicateOmit";
        hasOmit = true;
        continue;
      }
      if (
        (typeof o.value !== p.valueType &&
          !(p.valueType === "string" && o.value === null)) ||
        (typeof o.value === "number" && !Number.isFinite(o.value))
      )
        return "invalidOptions";
      if (p.target === "standard") {
        const n = Number(o.value);
        if (
          (p.path === "temperature" && n < 0) ||
          (p.path === "top_p" && (n < 0 || n > 1)) ||
          (["max_tokens", "max_output_tokens"].includes(p.path) &&
            (!Number.isSafeInteger(n) || n < 1)) ||
          (p.path === "seed" && !Number.isSafeInteger(n))
        )
          return "invalidOptions";
      }
    }
    if (p.defaultOption !== null && !options.has(p.defaultOption))
      return "invalidOptions";
  }
  return null;
}

/** 只恢复完整有效的定义，不让损坏的持久化配置进入请求。 */
export function readModelParameters(value: unknown): ModelParameter[] {
  if (!Array.isArray(value)) return [];
  try {
    return validateModelParameters(value) === null ? value : [];
  } catch {
    return [];
  }
}

export function readParameterSelections(value: unknown): ParameterSelections {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => typeof v === "string"),
  );
}

/** 无会话覆盖时解析模型默认值；默认项缺失时使用第一项，不制造额外选项。 */
export function selectedParameterOption(
  p: ModelParameter,
  selections: ParameterSelections = {},
) {
  const selected = selections[p.id];
  return (
    p.options.find((o) => o.id === selected) ??
    p.options.find((o) => o.id === p.defaultOption) ??
    p.options[0]
  );
}

/** 在轮次开始时生成实际值快照，不保留可编辑定义或选项对象的引用。 */
export function resolveModelParameters(
  parameters: readonly ModelParameter[],
  selections: ParameterSelections = {},
): ParameterAssignment[] {
  return parameters.flatMap((p) => {
    const option = selectedParameterOption(p, selections);
    return option && !option.omit
      ? [{ target: p.target, path: p.path, value: option.value }]
      : [];
  });
}

const COMPATIBLE_ALIASES: Record<string, string> = {
  reasoning_effort: "reasoningEffort",
  verbosity: "textVerbosity",
};
const RESPONSE_ALIASES: Record<string, string> = {
  "reasoning.effort": "reasoningEffort",
  "reasoning.summary": "reasoningSummary",
  "text.verbosity": "textVerbosity",
};

/** 按当前适配器转换路径，协议不同的字段不做全局合并。 */
function providerParameterPath(
  path: string,
  adapter: RuntimeAdapterId,
): string {
  if (
    adapter === "openai-compatible" ||
    adapter === "groq" ||
    adapter === "cerebras"
  )
    path = COMPATIBLE_ALIASES[path] ?? path;
  if (adapter === "openai" || adapter === "xai")
    path = RESPONSE_ALIASES[path] ?? COMPATIBLE_ALIASES[path] ?? path;
  if (
    ["openai", "xai", "groq", "cerebras"].includes(adapter) &&
    path === "parallel_tool_calls"
  )
    path = "parallelToolCalls";
  if (adapter === "anthropic" && path === "thinking.budget_tokens")
    path = "thinking.budgetTokens";
  if (adapter === "google")
    path =
      (
        {
          "thinking_config.thinking_budget": "thinkingConfig.thinkingBudget",
          "thinking_config.thinking_level": "thinkingConfig.thinkingLevel",
          "thinking_config.include_thoughts": "thinkingConfig.includeThoughts",
        } as Record<string, string>
      )[path] ?? path;
  return path;
}

/** 仅转换 SDK 已定义的字段，其余扩展保留官方参数名及嵌套结构。 */
export function buildParameterOptions(
  assignments: readonly ParameterAssignment[],
  adapter: RuntimeAdapterId,
  provider: string,
) {
  const standard: Partial<
    Record<(typeof STANDARD_FIELDS)[keyof typeof STANDARD_FIELDS], number>
  > = {};
  const extension: Record<string, JSONValue> = {};
  for (const a of assignments) {
    if (a.target === "standard") {
      standard[STANDARD_FIELDS[a.path as keyof typeof STANDARD_FIELDS]] =
        a.value as number;
      continue;
    }
    const path = providerParameterPath(a.path, adapter);
    const parts = path.split(".");
    let node = extension;
    for (const part of parts.slice(0, -1)) {
      if (
        node[part] !== undefined &&
        (node[part] === null || typeof node[part] !== "object")
      )
        throw new Error(`Model parameter paths overlap: ${a.path}`);
      node[part] ??= {};
      node = node[part] as Record<string, JSONValue>;
    }
    if (node[parts[parts.length - 1]] !== undefined)
      throw new Error(`Model parameter paths overlap: ${a.path}`);
    node[parts[parts.length - 1]] = a.value;
  }
  const namespace =
    adapter === "openai-compatible"
      ? provider === "openai-compatible"
        ? "openaiCompatible"
        : provider
      : adapter;
  return {
    ...standard,
    ...(Object.keys(extension).length
      ? { providerOptions: { [namespace]: extension } }
      : {}),
  };
}
