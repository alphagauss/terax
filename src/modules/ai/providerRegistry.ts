/**
 * 本文件集中定义内置 AI Provider 及其连接协议。
 * 注册表只保存稳定的端点、凭据、模型目录和运行时适配信息，不包含模型清单或用户密钥。
 */

export type CatalogAuthDefinition =
  | { kind: "bearer" }
  | { kind: "header"; name: string }
  | { kind: "query"; name: string };

export type ProviderCredentialDefinition =
  | { adapter: "none" }
  | {
      adapter: "api-key";
      required: boolean;
      keyringAccount: string | null;
      keyPrefix: string | null;
      catalogAuth: CatalogAuthDefinition;
    };

export type ProviderEndpointDefinition = {
  defaultBaseURL?: string;
  allowPrivateNetwork: boolean;
};

export type CatalogAdapterId = "openai" | "anthropic" | "google" | "xai";

export type RuntimeAdapterId =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "cerebras"
  | "groq"
  | "openai-compatible";

export type ProviderDefinition = {
  label: string;
  consoleUrl: string;
  builtin: boolean;
  category: "cloud" | "local" | "custom";
  endpoint: ProviderEndpointDefinition;
  credential: ProviderCredentialDefinition;
  catalog: {
    adapter: CatalogAdapterId;
    path: string;
    headers?: Readonly<Record<string, string>>;
  };
  runtime: {
    adapter: RuntimeAdapterId;
    headers?: Readonly<Record<string, string>>;
  };
};

/** 为使用标准目录和 Bearer 凭据的兼容云服务提供共同默认值。 */
function compatibleCloudProvider(input: {
  label: string;
  consoleUrl: string;
  baseURL: string;
  keyringAccount: string;
  keyPrefix?: string;
  headers?: Readonly<Record<string, string>>;
}): ProviderDefinition {
  return {
    label: input.label,
    consoleUrl: input.consoleUrl,
    builtin: true,
    category: "cloud",
    endpoint: { defaultBaseURL: input.baseURL, allowPrivateNetwork: false },
    credential: {
      adapter: "api-key",
      required: true,
      keyringAccount: input.keyringAccount,
      keyPrefix: input.keyPrefix ?? null,
      catalogAuth: { kind: "bearer" },
    },
    catalog: { adapter: "openai", path: "models" },
    runtime: {
      adapter: "openai-compatible",
      ...(input.headers ? { headers: input.headers } : {}),
    },
  };
}

export const PROVIDER_DEFINITIONS = {
  openai: {
    label: "OpenAI",
    consoleUrl: "https://platform.openai.com/api-keys",
    builtin: true,
    category: "cloud",
    endpoint: {
      defaultBaseURL: "https://api.openai.com/v1",
      allowPrivateNetwork: false,
    },
    credential: {
      adapter: "api-key",
      required: true,
      keyringAccount: "openai-api-key",
      keyPrefix: "sk-",
      catalogAuth: { kind: "bearer" },
    },
    catalog: { adapter: "openai", path: "models" },
    runtime: { adapter: "openai" },
  },
  anthropic: {
    label: "Anthropic",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    builtin: true,
    category: "cloud",
    endpoint: {
      defaultBaseURL: "https://api.anthropic.com/v1",
      allowPrivateNetwork: false,
    },
    credential: {
      adapter: "api-key",
      required: true,
      keyringAccount: "anthropic-api-key",
      keyPrefix: "sk-ant-",
      catalogAuth: { kind: "header", name: "x-api-key" },
    },
    catalog: {
      adapter: "anthropic",
      path: "models",
      headers: { "anthropic-version": "2023-06-01" },
    },
    runtime: { adapter: "anthropic" },
  },
  google: {
    label: "Google",
    consoleUrl: "https://aistudio.google.com/apikey",
    builtin: true,
    category: "cloud",
    endpoint: {
      defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
      allowPrivateNetwork: false,
    },
    credential: {
      adapter: "api-key",
      required: true,
      keyringAccount: "google-api-key",
      keyPrefix: null,
      catalogAuth: { kind: "query", name: "key" },
    },
    catalog: { adapter: "google", path: "models" },
    runtime: { adapter: "google" },
  },
  xai: {
    label: "xAI",
    consoleUrl: "https://console.x.ai/",
    builtin: true,
    category: "cloud",
    endpoint: {
      defaultBaseURL: "https://api.x.ai/v1",
      allowPrivateNetwork: false,
    },
    credential: {
      adapter: "api-key",
      required: true,
      keyringAccount: "xai-api-key",
      keyPrefix: "xai-",
      catalogAuth: { kind: "bearer" },
    },
    catalog: { adapter: "xai", path: "language-models" },
    runtime: { adapter: "xai" },
  },
  cerebras: {
    label: "Cerebras",
    consoleUrl: "https://cloud.cerebras.ai/",
    builtin: true,
    category: "cloud",
    endpoint: {
      defaultBaseURL: "https://api.cerebras.ai/v1",
      allowPrivateNetwork: false,
    },
    credential: {
      adapter: "api-key",
      required: true,
      keyringAccount: "cerebras-api-key",
      keyPrefix: "csk-",
      catalogAuth: { kind: "bearer" },
    },
    catalog: { adapter: "openai", path: "models" },
    runtime: { adapter: "cerebras" },
  },
  groq: {
    label: "Groq",
    consoleUrl: "https://console.groq.com/keys",
    builtin: true,
    category: "cloud",
    endpoint: {
      defaultBaseURL: "https://api.groq.com/openai/v1",
      allowPrivateNetwork: false,
    },
    credential: {
      adapter: "api-key",
      required: true,
      keyringAccount: "groq-api-key",
      keyPrefix: "gsk_",
      catalogAuth: { kind: "bearer" },
    },
    catalog: { adapter: "openai", path: "models" },
    runtime: { adapter: "groq" },
  },
  deepseek: compatibleCloudProvider({
    label: "DeepSeek",
    consoleUrl: "https://platform.deepseek.com/api_keys",
    baseURL: "https://api.deepseek.com",
    keyringAccount: "deepseek-api-key",
    keyPrefix: "sk-",
  }),
  mistral: compatibleCloudProvider({
    label: "Mistral",
    consoleUrl: "https://console.mistral.ai/api-keys/",
    baseURL: "https://api.mistral.ai/v1",
    keyringAccount: "mistral-api-key",
  }),
  zhipu: compatibleCloudProvider({
    label: "Zhipu AI (GLM)",
    consoleUrl: "https://bigmodel.cn/",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    keyringAccount: "zhipu-api-key",
  }),
  openrouter: compatibleCloudProvider({
    label: "OpenRouter",
    consoleUrl: "https://openrouter.ai/keys",
    baseURL: "https://openrouter.ai/api/v1",
    keyringAccount: "openrouter-api-key",
    keyPrefix: "sk-or-",
    headers: {
      "HTTP-Referer": "https://terax.ai",
      "X-Title": "Terax",
    },
  }),
  "openai-compatible": {
    label: "OpenAI Compatible",
    consoleUrl: "https://platform.openai.com/docs/api-reference",
    builtin: false,
    category: "custom",
    endpoint: { allowPrivateNetwork: true },
    credential: {
      adapter: "api-key",
      required: false,
      keyringAccount: null,
      keyPrefix: null,
      catalogAuth: { kind: "bearer" },
    },
    catalog: { adapter: "openai", path: "models" },
    runtime: { adapter: "openai-compatible" },
  },
  lmstudio: {
    label: "LM Studio",
    consoleUrl: "https://lmstudio.ai/docs/basics/server",
    builtin: true,
    category: "local",
    endpoint: {
      defaultBaseURL: "http://localhost:1234/v1",
      allowPrivateNetwork: true,
    },
    credential: { adapter: "none" },
    catalog: { adapter: "openai", path: "models" },
    runtime: { adapter: "openai-compatible" },
  },
  mlx: {
    label: "MLX",
    consoleUrl:
      "https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md",
    builtin: true,
    category: "local",
    endpoint: {
      defaultBaseURL: "http://127.0.0.1:8080/v1",
      allowPrivateNetwork: true,
    },
    credential: { adapter: "none" },
    catalog: { adapter: "openai", path: "models" },
    runtime: { adapter: "openai-compatible" },
  },
  ollama: {
    label: "Ollama",
    consoleUrl: "https://ollama.com/download",
    builtin: true,
    category: "local",
    endpoint: {
      defaultBaseURL: "http://localhost:11434/v1",
      allowPrivateNetwork: true,
    },
    credential: { adapter: "none" },
    catalog: { adapter: "openai", path: "models" },
    runtime: { adapter: "openai-compatible" },
  },
} as const satisfies Record<string, ProviderDefinition>;

export type ProviderId = keyof typeof PROVIDER_DEFINITIONS;

export type ProviderInfo = ProviderDefinition & { id: ProviderId };

export type ProviderBaseURLs = Partial<Record<ProviderId, string>>;

export type ResolvedProviderCredential =
  | { adapter: "none" }
  | {
      adapter: "api-key";
      value: string | null;
      required: boolean;
      catalogAuth: CatalogAuthDefinition;
    };

export type ResolvedProviderConnection = {
  instanceId: string;
  provider: ProviderId;
  baseURL: string;
  allowPrivateNetwork: boolean;
  credential: ResolvedProviderCredential;
  catalog: ProviderDefinition["catalog"];
  runtime: ProviderDefinition["runtime"];
};

export const PROVIDER_IDS: readonly ProviderId[] = Object.keys(
  PROVIDER_DEFINITIONS,
) as ProviderId[];

export const PROVIDERS: readonly ProviderInfo[] = PROVIDER_IDS.filter(
  (id) => PROVIDER_DEFINITIONS[id].builtin,
).map((id) => ({ id, ...PROVIDER_DEFINITIONS[id] }));

/** 返回 Provider 的静态协议定义。 */
export function getProvider(id: ProviderId): ProviderInfo {
  const definition = PROVIDER_DEFINITIONS[id];
  return { id, ...definition } as ProviderInfo;
}

/** 判断 Provider 是否接受 API key。 */
export function providerSupportsApiKey(id: ProviderId): boolean {
  return getProvider(id).credential.adapter === "api-key";
}

/** 判断 Provider 是否必须具备 API key 才能调用。 */
export function providerRequiresCredential(id: ProviderId): boolean {
  const credential = getProvider(id).credential;
  return credential.adapter === "api-key" && credential.required;
}

/** 解析用户覆盖或默认 Provider 地址，空白覆盖恢复默认值。 */
export function resolveProviderBaseURL(
  provider: ProviderId,
  override?: string,
): string {
  const endpoint = getProvider(provider).endpoint;
  return override?.trim() || endpoint.defaultBaseURL || "";
}

/**
 * 构造目录与运行时共享的 Provider 连接。
 * 凭据值只保留在进程内，OAuth 后续可通过新增 credential adapter 接入同一边界。
 */
export function createProviderConnection(input: {
  instanceId: string;
  provider: ProviderId;
  baseURL?: string;
  credentialValue?: string | null;
}): ResolvedProviderConnection {
  const definition = getProvider(input.provider);
  return {
    instanceId: input.instanceId,
    provider: input.provider,
    baseURL: resolveProviderBaseURL(input.provider, input.baseURL),
    allowPrivateNetwork: definition.endpoint.allowPrivateNetwork,
    credential:
      definition.credential.adapter === "none"
        ? { adapter: "none" }
        : {
            adapter: "api-key",
            value: input.credentialValue?.trim() || null,
            required: definition.credential.required,
            catalogAuth: definition.credential.catalogAuth,
          },
    catalog: definition.catalog,
    runtime: definition.runtime,
  };
}

/** 判断连接是否具备调用所需的地址和凭据。 */
export function isProviderConnectionReady(
  connection: ResolvedProviderConnection,
): boolean {
  if (!connection.baseURL) return false;
  const credential = connection.credential;
  return (
    credential.adapter === "none" || !credential.required || !!credential.value
  );
}

/** 地址覆盖按 Provider 独立持久化，避免不同窗口写回过时的整张映射。 */
export const PROVIDER_BASE_URL_PREFIX = "providerBaseURL:";

/** 从共享设置读取已登记 Provider 的非默认地址覆盖。 */
export function readProviderBaseURLs(
  values: Readonly<Record<string, unknown>>,
): ProviderBaseURLs {
  const result: ProviderBaseURLs = {};
  for (const provider of PROVIDERS) {
    const value = values[PROVIDER_BASE_URL_PREFIX + provider.id];
    if (typeof value !== "string") continue;
    const url = value.trim();
    if (url && url !== provider.endpoint.defaultBaseURL)
      result[provider.id] = url;
  }
  return result;
}
