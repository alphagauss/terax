/**
 * 本文件定义 AI Provider 实例、用户模型引用和 Agent 运行参数。
 * 运行时只从结构化配置解析连接，不维护易过时的静态模型目录。
 */

import {
  createProviderConnection,
  PROVIDERS,
  type ProviderBaseURLs,
  type ProviderId,
  providerRequiresCredential,
  type ResolvedProviderConnection,
} from "./providerRegistry";

export {
  getProvider,
  PROVIDERS,
  type ProviderBaseURLs,
  type ProviderId,
  type ProviderInfo,
  providerHasEditableBaseURL,
  providerRequiresCredential,
  resolveProviderBaseURL,
} from "./providerRegistry";

export const KEYRING_SERVICE = "terax-ai";

/** 可持久化的自定义 Provider 连接实例，模型集合由独立设置保存。 */
export type ProviderInstance = {
  id: string;
  protocol: "openai-compatible";
  name: string;
  baseURL: string;
};

const CUSTOM_PROVIDER_ID_PATTERN =
  /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 统一引用一个 Provider 实例提供的真实模型。 */
export type ModelRef = {
  providerId: string;
  modelId: string;
};

/** 用户明确添加到某个 Provider 的模型。 */
export type ConfiguredModel = {
  id: string;
  source: "discovered" | "manual";
  contextWindow: number;
};

export type ProviderModels = Record<string, ConfiguredModel[]>;

const MAX_MODEL_ID_LENGTH = 512;
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
export const MIN_MODEL_CONTEXT_WINDOW = 1_000;

/** 归一化外部或用户提供的模型 ID，并拒绝控制字符和异常长度。 */
export function normalizeModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id &&
    id.length <= MAX_MODEL_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(id)
    ? id
    : null;
}

function isConfiguredModel(
  value: unknown,
): value is Pick<ConfiguredModel, "id" | "source"> &
  Partial<Pick<ConfiguredModel, "contextWindow">> {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<ConfiguredModel>;
  return (
    normalizeModelId(model.id) !== null &&
    (model.source === "discovered" || model.source === "manual")
  );
}

/** 校验模型上下文窗口；缺失或损坏的持久化值回到统一默认值。 */
export function normalizeModelContextWindow(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_MODEL_CONTEXT_WINDOW
    ? value
    : DEFAULT_MODEL_CONTEXT_WINDOW;
}

/** 解析设置页中的 token 数量，支持整数以及 k、m 简写。 */
export function parseModelContextWindow(value: string): number | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
  if (!match) return null;
  const multiplier =
    match[2]?.toLowerCase() === "m"
      ? 1_000_000
      : match[2]?.toLowerCase() === "k"
        ? 1_000
        : 1;
  const parsed = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(parsed) || parsed < MIN_MODEL_CONTEXT_WINDOW) {
    return null;
  }
  return parsed;
}

/** 校验、归一化并去重外部或待保存的模型配置。 */
export function normalizeConfiguredModels(
  values: readonly unknown[],
): ConfiguredModel[] {
  const seen = new Set<string>();
  const models: ConfiguredModel[] = [];
  for (const value of values) {
    if (!isConfiguredModel(value)) continue;
    const id = normalizeModelId(value.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      source: value.source,
      contextWindow: normalizeModelContextWindow(value.contextWindow),
    });
  }
  return models;
}

/** 查找用户已经添加到 Provider 的模型。 */
function findConfiguredModel(
  models: Readonly<ProviderModels>,
  ref: ModelRef,
): ConfiguredModel | undefined {
  return models[ref.providerId]?.find((model) => model.id === ref.modelId);
}

/** 返回模型保存的上下文窗口；不可用引用使用统一默认值。 */
export function getModelContextWindow(
  ref: ModelRef | null,
  models: Readonly<ProviderModels>,
): number {
  if (!ref) return DEFAULT_MODEL_CONTEXT_WINDOW;
  return (
    findConfiguredModel(models, ref)?.contextWindow ??
    DEFAULT_MODEL_CONTEXT_WINDOW
  );
}

/** 返回内置 Provider 的稳定实例 ID。 */
export function builtinProviderId(provider: ProviderId): string {
  return `builtin:${provider}`;
}

/** 将内置实例 ID 还原为 Provider；自定义或未知实例返回 null。 */
export function providerFromBuiltinId(providerId: string): ProviderId | null {
  return (
    PROVIDERS.find((provider) => builtinProviderId(provider.id) === providerId)
      ?.id ?? null
  );
}

/** 为内置模型构造统一引用。 */
export function modelRefForProvider(
  provider: ProviderId,
  modelId: string,
): ModelRef {
  return { providerId: builtinProviderId(provider), modelId };
}

/** 判断两个模型引用是否指向同一 Provider 实例和模型。 */
export function modelRefsEqual(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/** 为集合与 React key 生成无歧义的模型引用键。 */
export function modelRefKey(ref: ModelRef): string {
  return JSON.stringify([ref.providerId, ref.modelId]);
}

/** 判断持久化值是否为应用生成的自定义 Provider 实例。 */
export function isProviderInstance(value: unknown): value is ProviderInstance {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProviderInstance>;
  return (
    typeof candidate.id === "string" &&
    CUSTOM_PROVIDER_ID_PATTERN.test(candidate.id) &&
    candidate.protocol === "openai-compatible" &&
    typeof candidate.name === "string" &&
    typeof candidate.baseURL === "string"
  );
}

export type ResolvedModel = {
  id: string;
  provider: ProviderId;
  label: string;
  ref: ModelRef;
  providerId: string;
  baseURL: string;
};

export type ProviderResolutionConfig = {
  customProviders?: readonly ProviderInstance[];
  providerBaseURLs?: Readonly<ProviderBaseURLs>;
  providerCredentials?: Readonly<Partial<Record<ProviderId, string | null>>>;
  providerInstanceCredentials?: Readonly<Record<string, string | null>>;
};

/** 将内置或自定义 Provider 实例解析为统一连接。 */
export function resolveProviderInstance(
  providerId: string,
  config: ProviderResolutionConfig = {},
): ResolvedProviderConnection {
  const custom = config.customProviders?.find(
    (provider) => provider.id === providerId,
  );
  if (custom) {
    return createProviderConnection({
      instanceId: custom.id,
      provider: custom.protocol,
      baseURL: custom.baseURL,
      credentialValue: config.providerInstanceCredentials?.[custom.id],
    });
  }

  const provider = providerFromBuiltinId(providerId);
  if (!provider) throw new Error(`Unknown provider instance: ${providerId}`);
  return createProviderConnection({
    instanceId: providerId,
    provider,
    baseURL: config.providerBaseURLs?.[provider],
    credentialValue: config.providerCredentials?.[provider],
  });
}

/**
 * 将模型引用解析为运行时连接信息。
 * 模型 ID 由用户配置持有，不依赖远端目录缓存或代码内静态名单。
 */
export function resolveModel(
  ref: ModelRef,
  config: ProviderResolutionConfig = {},
): ResolvedModel {
  const modelId = normalizeModelId(ref.modelId);
  if (!modelId) throw new Error("Model ID is invalid");
  const connection = resolveProviderInstance(ref.providerId, config);
  return {
    id: modelId,
    provider: connection.provider,
    providerId: ref.providerId,
    ref: { ...ref, modelId },
    label: modelId,
    baseURL: connection.baseURL,
  };
}

/** 尝试解析模型引用，供展示层和可选配置安全读取。 */
export function tryResolveModel(
  ref: ModelRef | null,
  config: ProviderResolutionConfig = {},
): ResolvedModel | null {
  if (!ref) return null;
  try {
    return resolveModel(ref, config);
  } catch {
    return null;
  }
}

/** 判断持久化值是否为当前统一模型引用。 */
export function isModelRef(value: unknown): value is ModelRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ModelRef>;
  return (
    typeof candidate.providerId === "string" &&
    candidate.providerId.length > 0 &&
    typeof candidate.modelId === "string" &&
    candidate.modelId.length > 0
  );
}

/** 判断模型引用是否属于当前用户添加的 Provider 模型。 */
export function isModelRefAvailable(
  ref: ModelRef,
  providerModels: Readonly<ProviderModels> = {},
  config: ProviderResolutionConfig = {},
): boolean {
  if (!ref.modelId.trim() || !findConfiguredModel(providerModels, ref)) {
    return false;
  }
  try {
    return !!resolveProviderInstance(ref.providerId, config).baseURL;
  } catch {
    return false;
  }
}

/** 根据统一模型引用判断发送前是否必须具备 Provider 凭据。 */
export function modelRequiresCredential(
  ref: ModelRef,
  config: ProviderResolutionConfig = {},
): boolean {
  return providerRequiresCredential(resolveModel(ref, config).provider);
}

export type SttProvider = "openai" | "groq" | "whispercpp";

export const STT_PROVIDER_LABELS: Record<SttProvider, string> = {
  openai: "OpenAI Whisper",
  groq: "Groq Whisper",
  whispercpp: "Whisper.cpp (local)",
};

export const DEFAULT_STT_PROVIDER: SttProvider = "openai";
export const WHISPERCPP_DEFAULT_BASE_URL = "http://127.0.0.1:8080";
export const TERMINAL_BUFFER_LINES = 300;

export const MAX_AGENT_STEPS_DEFAULT: number | null = null;
export const MAX_SUBAGENT_STEPS_DEFAULT = 32;
export const AGENT_STEPS_MIN = 8;
export const AGENT_STEPS_MAX = 256;

/** 将 Agent 步数限制约束到设置界面允许的范围。 */
export function clampAgentSteps(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(
    AGENT_STEPS_MAX,
    Math.max(AGENT_STEPS_MIN, Math.round(value)),
  );
}

/** 主 Agent 使用 null 表示无限，数值模式与 Subagent 共用范围约束。 */
export function normalizeMainAgentSteps(
  value: number | null,
  fallback: number | null = MAX_AGENT_STEPS_DEFAULT,
): number | null {
  if (value === null || value === 0) return null;
  if (!Number.isFinite(value)) return fallback;
  return clampAgentSteps(value, AGENT_STEPS_MIN);
}

export const MAX_CONCURRENT_SUBAGENTS_DEFAULT = 3;
export const MAX_CONCURRENT_SUBAGENTS_MIN = 1;
export const MAX_CONCURRENT_SUBAGENTS_MAX = 8;

/** 将每聊天 Subagent 并发数约束到设置界面允许的安全范围。 */
export function clampMaxConcurrentSubagents(value: number): number {
  if (!Number.isFinite(value)) return MAX_CONCURRENT_SUBAGENTS_DEFAULT;
  return Math.min(
    MAX_CONCURRENT_SUBAGENTS_MAX,
    Math.max(MAX_CONCURRENT_SUBAGENTS_MIN, Math.round(value)),
  );
}
