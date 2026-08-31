/**
 * 本文件定义 AI Provider、模型能力、默认配置和基础系统提示词。
 * 运行时密钥与会话目录不在此持久化，固定 cwd 由会话层注入系统提示词。
 */

export const KEYRING_SERVICE = "terax-ai";

export type ProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "cerebras"
  | "groq"
  | "deepseek"
  | "mistral"
  | "openrouter"
  | "openai-compatible"
  | "lmstudio"
  | "mlx"
  | "ollama";

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  keyringAccount: string;
  keyPrefix: string | null;
  consoleUrl: string;
  /** Provider accepts (but does not require) an API key. */
  keyOptional?: boolean;
};

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "openai",
    label: "OpenAI",
    keyringAccount: "openai-api-key",
    keyPrefix: "sk-",
    consoleUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    keyringAccount: "anthropic-api-key",
    keyPrefix: "sk-ant-",
    consoleUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "google",
    label: "Google",
    keyringAccount: "google-api-key",
    keyPrefix: null,
    consoleUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "xai",
    label: "xAI",
    keyringAccount: "xai-api-key",
    keyPrefix: "xai-",
    consoleUrl: "https://console.x.ai/",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    keyringAccount: "cerebras-api-key",
    keyPrefix: "csk-",
    consoleUrl: "https://cloud.cerebras.ai/",
  },
  {
    id: "groq",
    label: "Groq",
    keyringAccount: "groq-api-key",
    keyPrefix: "gsk_",
    consoleUrl: "https://console.groq.com/keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    keyringAccount: "deepseek-api-key",
    keyPrefix: "sk-",
    consoleUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "mistral",
    label: "Mistral",
    keyringAccount: "mistral-api-key",
    keyPrefix: null,
    consoleUrl: "https://console.mistral.ai/api-keys/",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    keyringAccount: "openrouter-api-key",
    keyPrefix: "sk-or-",
    consoleUrl: "https://openrouter.ai/keys",
  },
  {
    id: "openai-compatible",
    label: "OpenAI Compatible",
    keyringAccount: "openai-compatible-api-key",
    keyPrefix: null,
    consoleUrl: "https://platform.openai.com/docs/api-reference",
    keyOptional: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    keyringAccount: "",
    keyPrefix: null,
    consoleUrl: "https://lmstudio.ai/docs/basics/server",
  },
  {
    id: "mlx",
    label: "MLX",
    keyringAccount: "",
    keyPrefix: null,
    consoleUrl:
      "https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md",
  },
  {
    id: "ollama",
    label: "Ollama",
    keyringAccount: "",
    keyPrefix: null,
    consoleUrl: "https://ollama.com/download",
  },
] as const;

export type CustomEndpoint = {
  id: string;
  name: string;
  baseURL: string;
  modelId: string;
  contextLimit: number;
};

const COMPAT_MODEL_PREFIX = "compat-";

export function compatModelIdForEndpoint(endpointId: string): string {
  return `${COMPAT_MODEL_PREFIX}${endpointId}`;
}

export function isCompatModelId(modelId: string): boolean {
  return modelId.startsWith(COMPAT_MODEL_PREFIX);
}

export function endpointIdFromCompatModel(modelId: string): string {
  return isCompatModelId(modelId)
    ? modelId.slice(COMPAT_MODEL_PREFIX.length)
    : "";
}

export function getProvider(id: ProviderId): ProviderInfo {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

/** 1 (lowest) – 5 (highest). For `cost`, higher = cheaper. */
export type CapabilityScore = 1 | 2 | 3 | 4 | 5;

export type ModelCapabilities = {
  intelligence: CapabilityScore;
  speed: CapabilityScore;
  cost: CapabilityScore;
};

export type ModelTag = "vision" | "reasoning" | "tools" | "coding";

export type ModelInfo = {
  id: string;
  provider: ProviderId;
  label: string;
  /** One short word for the dropdown trigger. */
  hint: string;
  /** One-line marketing-style description shown under the label. */
  description: string;
  capabilities: ModelCapabilities;
  tags?: readonly ModelTag[];
  supportsTemperature?: boolean;
};

export const MODELS = [
  // ── OpenAI ────────────────────────────────────────────────────────────────
  {
    id: "gpt-5.6",
    provider: "openai",
    label: "GPT-5.6 Sol",
    hint: "Flagship",
    description: "Frontier model for complex professional and agentic work.",
    capabilities: { intelligence: 5, speed: 4, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    supportsTemperature: false,
  },
  {
    id: "gpt-5.6-terra",
    provider: "openai",
    label: "GPT-5.6 Terra",
    hint: "Balanced",
    description: "Strong intelligence with lower cost and latency.",
    capabilities: { intelligence: 5, speed: 4, cost: 2 },
    tags: ["vision", "reasoning", "tools", "coding"],
    supportsTemperature: false,
  },
  {
    id: "gpt-5.6-luna",
    provider: "openai",
    label: "GPT-5.6 Luna",
    hint: "Fast",
    description: "Fast, affordable reasoning for high-volume work.",
    capabilities: { intelligence: 4, speed: 5, cost: 3 },
    tags: ["vision", "reasoning", "tools", "coding"],
    supportsTemperature: false,
  },
  {
    id: "gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    hint: "Flagship",
    description: "Frontier reasoning and code.",
    capabilities: { intelligence: 5, speed: 3, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    supportsTemperature: false,
  },
  {
    id: "gpt-5.5-pro",
    provider: "openai",
    label: "GPT-5.5 Pro",
    hint: "Max",
    description:
      "Highest-accuracy version for the hardest professional and agentic tasks.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    supportsTemperature: false,
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    label: "GPT-5.4 mini",
    hint: "Fast",
    description: "Snappy default at low cost.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools"],
    supportsTemperature: false,
  },
  {
    id: "gpt-5.4-nano",
    provider: "openai",
    label: "GPT-5.4 nano",
    hint: "Fastest",
      description: "Tiny and instant, great for autocomplete.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools"],
    supportsTemperature: false,
  },
  {
    id: "gpt-5.3-codex",
    provider: "openai",
    label: "GPT-5.3 Codex",
    hint: "Coding",
    description: "Tuned for code and tool use.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["tools", "coding"],
    supportsTemperature: false,
  },
  {
    id: "gpt-4.1-mini",
    provider: "openai",
    label: "GPT-4.1 mini",
    hint: "Cheap",
    description: "Ultra-cheap workhorse for bulk tasks.",
    capabilities: { intelligence: 3, speed: 4, cost: 5 },
    tags: ["vision", "tools"],
  },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  {
    id: "claude-fable-5",
    provider: "anthropic",
    label: "Claude Fable 5",
    hint: "Frontier",
    description:
      "Most capable Claude for demanding reasoning and long-horizon agentic work.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    supportsTemperature: false,
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    label: "Claude Sonnet 5",
    hint: "Balanced",
    description: "Best combination of Claude intelligence and speed.",
    capabilities: { intelligence: 5, speed: 4, cost: 3 },
    tags: ["vision", "reasoning", "tools", "coding"],
    supportsTemperature: false,
  },
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    label: "Claude Opus 4.8",
    hint: "Best",
    description:
      "Anthropic's most capable model for complex reasoning and long-horizon agentic coding.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    supportsTemperature: false,
  },
  {
    id: "claude-opus-4-7",
    provider: "anthropic",
    label: "Claude Opus 4.7",
    hint: "Previous",
    description: "Previous-gen flagship for long reasoning.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    supportsTemperature: false,
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    label: "Claude Sonnet 4.6",
    hint: "Balanced",
    description: "Sweet spot of quality and speed.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    hint: "Fast",
    description: "Quick, cheap, multimodal.",
    capabilities: { intelligence: 3, speed: 5, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    label: "Claude Opus 4.6",
    hint: "Legacy",
    description: "Previous-gen Opus.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },

  // ── Google ────────────────────────────────────────────────────────────────
  {
    id: "gemini-3.5-flash",
    provider: "google",
    label: "Gemini 3.5 Flash",
    hint: "Fast",
    description: "High-intelligence, extremely fast multimodal model.",
    capabilities: { intelligence: 4, speed: 5, cost: 4 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "gemini-3.1-flash-lite",
    provider: "google",
    label: "Gemini 3.1 Flash-Lite",
    hint: "Lite",
    description: "Extremely fast, cheap, and lightweight multimodal model.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["vision", "tools"],
  },
  {
    id: "gemini-3.1-pro-preview",
    provider: "google",
    label: "Gemini 3.1 Pro",
    hint: "Flagship",
    description: "Strong reasoning, 1M context.",
    capabilities: { intelligence: 5, speed: 3, cost: 2 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "gemini-3-flash-preview",
    provider: "google",
    label: "Gemini 3 Flash",
    hint: "Fast",
    description: "Fast multimodal, 1M context.",
    capabilities: { intelligence: 4, speed: 5, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    label: "Gemini 2.5 Pro",
    hint: "Stable",
    description: "Production-stable Gemini.",
    capabilities: { intelligence: 4, speed: 3, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    label: "Gemini 2.5 Flash",
    hint: "Cheap",
    description: "Bulk throughput at low cost.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["vision", "tools"],
  },

  // ── xAI ───────────────────────────────────────────────────────────────────
  {
    id: "grok-4.5",
    provider: "xai",
    label: "Grok 4.5",
    hint: "Frontier",
    description: "Frontier coding, agentic, and knowledge-work model.",
    capabilities: { intelligence: 5, speed: 4, cost: 2 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "grok-4.20-reasoning",
    provider: "xai",
    label: "Grok 4.20 Reasoning",
    hint: "Reasoning",
    description: "Frontier reasoning with extended thinking.",
    capabilities: { intelligence: 5, speed: 2, cost: 2 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "grok-4.20-non-reasoning",
    provider: "xai",
    label: "Grok 4.20",
    hint: "Fast",
    description: "Fast tier for chat and tools.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["tools"],
  },
  {
    id: "grok-4-fast-reasoning",
    provider: "xai",
    label: "Grok 4 Fast",
    hint: "Reasoning",
    description: "Cheaper Grok 4 with vision and reasoning.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "reasoning", "tools"],
  },
  {
    id: "grok-4.3",
    provider: "xai",
    label: "Grok 4.3",
    hint: "Flagship",
    description:
      "Most intelligent and fastest Grok. Strong agentic tool use and 1M context.",
    capabilities: { intelligence: 5, speed: 4, cost: 2 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "grok-build-0.1",
    provider: "xai",
    label: "Grok Build 0.1",
    hint: "Coding",
    description:
      "Specialized fast coding model for agentic workflows (powers Grok Build CLI).",
    capabilities: { intelligence: 4, speed: 5, cost: 4 },
    tags: ["tools", "coding"],
  },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    label: "DeepSeek V4 Pro",
    hint: "Best",
    description: "Strong open-weight code model.",
    capabilities: { intelligence: 5, speed: 3, cost: 4 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    label: "DeepSeek V4 Flash",
    hint: "Fast",
    description: "Cheap and fast everyday tier.",
    capabilities: { intelligence: 4, speed: 5, cost: 5 },
    tags: ["reasoning", "tools"],
  },
  {
    id: "deepseek-reasoner",
    provider: "deepseek",
    label: "DeepSeek Reasoner",
    hint: "Thinking",
    description: "Chain-of-thought at open-weight prices.",
    capabilities: { intelligence: 5, speed: 2, cost: 4 },
    tags: ["reasoning", "coding"],
  },

  // ── Mistral ────────────────────────────────────────────────────────────────
  {
    id: "mistral-large-latest",
    provider: "mistral",
    label: "Mistral Large 3",
    hint: "Best",
    description: "Flagship Mistral model with 128K context.",
    capabilities: { intelligence: 5, speed: 3, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "mistral-medium-latest",
    provider: "mistral",
    label: "Mistral Medium 3.5",
    hint: "Balanced",
    description: "Good balance of speed and intelligence.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "codestral-latest",
    provider: "mistral",
    label: "Codestral",
    hint: "Code",
    description: "Purpose-built coding model from Mistral.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["coding"],
  },

  // ── Cerebras (autocomplete-tier) ──────────────────────────────────────────
  {
    id: "gpt-oss-120b",
    provider: "cerebras",
    label: "GPT-OSS 120B",
    hint: "Ultra-fast",
    description: "Fastest inference on Cerebras silicon.",
    capabilities: { intelligence: 4, speed: 5, cost: 4 },
    tags: ["tools", "coding"],
  },
  {
    id: "llama3.3-70b",
    provider: "cerebras",
    label: "Llama 3.3 70B",
    hint: "Fast",
    description: "Meta's open model on wafer-scale silicon.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools"],
  },
  {
    id: "qwen-3-32b",
    provider: "cerebras",
    label: "Qwen 3 32B",
    hint: "Fast",
    description: "Multilingual model at extreme speed.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools", "coding"],
  },

  // ── Groq (autocomplete-tier) ──────────────────────────────────────────────
  {
    id: "openai/gpt-oss-20b",
    provider: "groq",
    label: "GPT-OSS 20B",
    hint: "Ultra-fast",
    description: "Sub-second responses on Groq LPU.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools", "coding"],
  },
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    label: "Llama 3.3 70B",
    hint: "Versatile",
    description: "Fast and broadly capable.",
    capabilities: { intelligence: 4, speed: 5, cost: 5 },
    tags: ["tools"],
  },
  {
    id: "deepseek-r1-distill-llama-70b",
    provider: "groq",
    label: "DeepSeek R1 Distill 70B",
    hint: "Thinking",
    description: "Reasoning-distilled Llama on Groq.",
    capabilities: { intelligence: 4, speed: 5, cost: 5 },
    tags: ["reasoning", "tools"],
  },

  // ── OpenRouter (gateway; model id is user-supplied at runtime) ────────────
  {
    id: "openrouter-custom",
    provider: "openrouter",
    label: "OpenRouter",
    hint: "Configurable",
    description: "Any model on OpenRouter by id.",
    capabilities: { intelligence: 3, speed: 3, cost: 3 },
  },

  // ── Generic OpenAI-compatible (user-defined endpoint) ─────────────────────
  {
    id: "openai-compatible-custom",
    provider: "openai-compatible",
    label: "Custom endpoint",
    hint: "Configurable",
    description: "Any OpenAI-compatible endpoint.",
    capabilities: { intelligence: 3, speed: 3, cost: 3 },
  },

  // ── LM Studio (local; model id is user-supplied at runtime) ───────────────
  {
    id: "lmstudio-local",
    provider: "lmstudio",
    label: "LM Studio",
    hint: "Local",
    description: "Local GGUF models via LM Studio.",
    capabilities: { intelligence: 3, speed: 3, cost: 5 },
  },

  // ── MLX (local; Apple-silicon; model id is user-supplied at runtime) ──────
  {
    id: "mlx-local",
    provider: "mlx",
    label: "MLX",
    hint: "Local",
    description: "Apple-silicon models via mlx_lm.server.",
    capabilities: { intelligence: 3, speed: 3, cost: 5 },
  },

  // ── Ollama (local; model id is user-supplied at runtime) ──────────────────
  {
    id: "ollama-local",
    provider: "ollama",
    label: "Ollama",
    hint: "Local",
    description: "Local models via Ollama.",
    capabilities: { intelligence: 3, speed: 3, cost: 5 },
  },
] as const satisfies readonly ModelInfo[];

export type ModelId = (typeof MODELS)[number]["id"];

export function getCompatModelInfo(
  modelId: string,
  endpoints: readonly CustomEndpoint[],
): ModelInfo {
  const eid = endpointIdFromCompatModel(modelId);
  const ep = endpoints.find((e) => e.id === eid);
  const name = ep?.name || "Custom endpoint";
  return {
    id: modelId,
    provider: "openai-compatible",
    label: ep?.modelId || name,
    hint: name,
    description: ep
              ? `${name} - ${ep.baseURL}`
      : "Custom OpenAI-compatible endpoint",
    capabilities: { intelligence: 3, speed: 3, cost: 3 },
  };
}

export function resolveModel(
  modelId: string,
  endpoints: readonly CustomEndpoint[] = [],
): ModelInfo {
  if (isCompatModelId(modelId)) return getCompatModelInfo(modelId, endpoints);
  const m = MODELS.find((x) => x.id === modelId);
  if (!m) throw new Error(`Unknown model: ${modelId}`);
  return m;
}

export function getModel(id: ModelId): ModelInfo {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown model: ${id}`);
  return m;
}

export function isKnownModelId(id: string): id is ModelId {
  return MODELS.some((x) => x.id === id);
}

const FREEFORM_PROVIDERS: ReadonlySet<ProviderId> = new Set([
  "openrouter",
  "openai-compatible",
  "lmstudio",
  "mlx",
  "ollama",
]);

// Reasoning models reject tool-call turns whose reasoning was stripped; keep it.
export function modelKeepsReasoning(m: ModelInfo): boolean {
  return (
    (m.tags?.includes("reasoning") ?? false) ||
    FREEFORM_PROVIDERS.has(m.provider)
  );
}

export function modelSupportsTemperature(
  provider: ProviderId,
  modelId: string,
): boolean {
  const model: ModelInfo | undefined = MODELS.find(
    (m) => m.provider === provider && m.id === modelId,
  );
  return model?.supportsTemperature !== false;
}

export function modelUsesReasoningTokens(
  provider: ProviderId,
  modelId: string,
): boolean {
  const model: ModelInfo | undefined = MODELS.find(
    (m) => m.provider === provider && m.id === modelId,
  );
  return (
    (model?.tags?.includes("reasoning") ?? false) ||
    (provider === "openai" && /^gpt-5(?:[.-]|$)/.test(modelId)) ||
    /\bgpt-oss\b/i.test(modelId)
  );
}

export const DEFAULT_MODEL_ID: ModelId = "gpt-5.4-mini";

/**
 * 各模型的近似上下文窗口，用于 AI 侧栏的上下文用量指示器。
 * 数值采用保守估计，提供方限制可能变化。
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-5.6": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.5-pro": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4-nano": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-4.1-mini": 128_000,
  "claude-fable-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-opus-4-6": 1_000_000,
  "gemini-3.5-flash": 1_000_000,
  "gemini-3.1-flash-lite": 1_000_000,
  "gemini-3.1-pro-preview": 1_000_000,
  "gemini-3-flash-preview": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "grok-4.5": 500_000,
  "grok-4.20-reasoning": 2_000_000,
  "grok-4.20-non-reasoning": 2_000_000,
  "grok-4-fast-reasoning": 2_000_000,
  "grok-4.3": 1_000_000,
  "grok-build-0.1": 256_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-reasoner": 128_000,
  "gpt-oss-120b": 128_000,
  "llama3.3-70b": 128_000,
  "qwen-3-32b": 32_000,
  "openai/gpt-oss-20b": 128_000,
  "llama-3.3-70b-versatile": 128_000,
  "deepseek-r1-distill-llama-70b": 128_000,
  "openrouter-custom": 256_000,
  "openai-compatible-custom": 128_000,
  "lmstudio-local": 32_000,
  "mlx-local": 32_000,
  "ollama-local": 32_000,
  "mistral-large-latest": 131_072,
  "mistral-medium-latest": 32_768,
  "codestral-latest": 256_000,
};

export function getModelContextLimit(
  modelId: string | undefined,
  compatOverride?: number,
): number {
  if (!modelId) return 128_000;
  if (isCompatModelId(modelId)) return compatOverride ?? 128_000;
  if (modelId === "openai-compatible-custom" && compatOverride)
    return compatOverride;
  return MODEL_CONTEXT_LIMITS[modelId] ?? 128_000;
}

export type ModelPricing = {
  input: number;
  output: number;
  cacheRead?: number;
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5.6": { input: 5, output: 30, cacheRead: 0.5 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cacheRead: 0.25 },
  "gpt-5.6-luna": { input: 1, output: 6, cacheRead: 0.1 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02 },
  "gpt-5.3-codex": { input: 1.5, output: 6, cacheRead: 0.15 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-opus-4-7": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "gemini-3.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "gemini-3.1-flash-lite": { input: 0.075, output: 0.3, cacheRead: 0.015 },
  "gemini-3.1-pro-preview": { input: 1.25, output: 10, cacheRead: 0.31 },
  "gemini-3-flash-preview": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.31 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "grok-4.5": { input: 2, output: 6, cacheRead: 0.5 },
  "grok-4.20-reasoning": { input: 3, output: 15 },
  "grok-4.20-non-reasoning": { input: 1, output: 5 },
  "grok-4-fast-reasoning": { input: 0.2, output: 0.5 },
  "grok-4.3": { input: 1.25, output: 2.5 },
  "grok-build-0.1": { input: 1, output: 2 },
  "deepseek-v4-pro": { input: 0.28, output: 1.1, cacheRead: 0.028 },
  "deepseek-v4-flash": { input: 0.07, output: 0.27, cacheRead: 0.007 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, cacheRead: 0.14 },
};

export function estimateCost(
  modelId: string | undefined,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  },
): number | null {
  if (!modelId) return null;
  const p = MODEL_PRICING[modelId];
  if (!p) return null;
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cached = usage.cachedInputTokens;
  return (
    (fresh * p.input +
      cached * (p.cacheRead ?? p.input) +
      usage.outputTokens * p.output) /
    1_000_000
  );
}

/** Providers that do not require an API key (local servers, key-optional). */
export const KEYLESS_PROVIDERS: readonly ProviderId[] = [
  "lmstudio",
  "mlx",
  "ollama",
  "openai-compatible",
] as const;

export function providerNeedsKey(id: ProviderId): boolean {
  return !KEYLESS_PROVIDERS.includes(id);
}

/** 判断提供方是否接受 API 密钥，供设置页决定是否显示密钥卡片。 */
export function providerSupportsKey(id: ProviderId): boolean {
  if (providerNeedsKey(id)) return true;
  const p = getProvider(id);
  return !!p.keyOptional;
}

/** Any provider can power the editor's inline autocomplete; latency is the
 *  user's choice. The picker filters down to fast tiers in the UI. */
export type AutocompleteProviderId = ProviderId;

/** Sensible default model id per provider for inline autocomplete. */
export const DEFAULT_AUTOCOMPLETE_MODEL: Partial<Record<ProviderId, string>> = {
  cerebras: "gpt-oss-120b",
  groq: "openai/gpt-oss-20b",
  lmstudio: "qwen2.5-coder-7b-instruct",
  openai: "gpt-5.4-nano",
  anthropic: "claude-haiku-4-5",
  google: "gemini-2.5-flash",
  xai: "grok-4.3",
  deepseek: "deepseek-v4-flash",
  openrouter: "openai/gpt-5.4-mini",
  "openai-compatible": "",
};

/** Curated list of fast models suitable for inline completion (speed ≥ 4). */
export function getAutocompleteEligibleModels(): readonly ModelInfo[] {
  return MODELS.filter(
    (m) => m.capabilities.speed >= 4 && m.id !== "openai-compatible-custom",
  );
}

export type SttProvider = "openai" | "groq" | "whispercpp";

export const STT_PROVIDER_LABELS: Record<SttProvider, string> = {
  openai: "OpenAI Whisper",
  groq: "Groq Whisper",
  whispercpp: "Whisper.cpp (local)",
};

export const DEFAULT_STT_PROVIDER: SttProvider = "openai";
export const WHISPERCPP_DEFAULT_BASE_URL = "http://127.0.0.1:8080";
export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";
export const MLX_DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const OPENAI_COMPATIBLE_DEFAULT_BASE_URL = "";
export const MAX_AGENT_STEPS = 24;
export const TERMINAL_BUFFER_LINES = 300;

export const SYSTEM_PROMPT = `You are Terax, a hands-on engineering agent in a developer terminal. Complete the user's task instead of only describing how to do it.

# Work
- Inspect relevant state before drawing conclusions, then continue through change and verification in one turn.
- Ask one short question only when ambiguity is material and a wrong guess would be costly.
- Make the smallest change that solves the request. Do not refactor, clean up, or add features outside its scope.
- Follow each tool's description and schema. When the user requests a mutation, call the tool directly; the approval UI is the confirmation.
- Do not echo complete proposed content before a tool call, ask for redundant approval, or retry a final safety or workspace refusal.

# Responses
- Be concise and direct. State the reason in one short sentence before a mutation.
- After finishing, report the outcome and any necessary next step. Use language fences on code blocks.`;
