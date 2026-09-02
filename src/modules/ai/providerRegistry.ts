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

export type ProviderEndpointDefinition =
  | { kind: "fixed"; baseURL: string; allowPrivateNetwork: false }
  | {
      kind: "editable";
      defaultBaseURL?: string;
      allowPrivateNetwork: true;
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

export const PROVIDER_DEFINITIONS = {
  openai: {
    label: "OpenAI",
    consoleUrl: "https://platform.openai.com/api-keys",
    builtin: true,
    endpoint: {
      kind: "fixed",
      baseURL: "https://api.openai.com/v1",
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
    endpoint: {
      kind: "fixed",
      baseURL: "https://api.anthropic.com/v1",
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
    endpoint: {
      kind: "fixed",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
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
    endpoint: {
      kind: "fixed",
      baseURL: "https://api.x.ai/v1",
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
    endpoint: {
      kind: "fixed",
      baseURL: "https://api.cerebras.ai/v1",
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
    endpoint: {
      kind: "fixed",
      baseURL: "https://api.groq.com/openai/v1",
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
  deepseek: {
    label: "DeepSeek",
    consoleUrl: "https://platform.deepseek.com/api_keys",
    builtin: true,
    endpoint: {
      kind: "fixed",
      baseURL: "https://api.deepseek.com",
      allowPrivateNetwork: false,
    },
    credential: {
      adapter: "api-key",
      required: true,
      keyringAccount: "deepseek-api-key",
      keyPrefix: "sk-",
      catalogAuth: { kind: "bearer" },
    },
    catalog: { adapter: "openai", path: "models" },
    runtime: { adapter: "openai-compatible" },
  },
  mistral: {
    label: "Mistral",
    consoleUrl: "https://console.mistral.ai/api-keys/",
    builtin: true,
    endpoint: {
      kind: "fixed",
      baseURL: "https://api.mistral.ai/v1",
      allowPrivateNetwork: false,
    },
    credential: {
      adapter: "api-key",
      required: true,
      keyringAccount: "mistral-api-key",
      keyPrefix: null,
      catalogAuth: { kind: "bearer" },
    },
    catalog: { adapter: "openai", path: "models" },
    runtime: { adapter: "openai-compatible" },
  },
  openrouter: {
    label: "OpenRouter",
    consoleUrl: "https://openrouter.ai/keys",
    builtin: true,
    endpoint: {
      kind: "fixed",
      baseURL: "https://openrouter.ai/api/v1",
      allowPrivateNetwork: false,
    },
    credential: {
      adapter: "api-key",
      required: true,
      keyringAccount: "openrouter-api-key",
      keyPrefix: "sk-or-",
      catalogAuth: { kind: "bearer" },
    },
    catalog: { adapter: "openai", path: "models" },
    runtime: {
      adapter: "openai-compatible",
      headers: {
        "HTTP-Referer": "https://terax.ai",
        "X-Title": "Terax",
      },
    },
  },
  "openai-compatible": {
    label: "OpenAI Compatible",
    consoleUrl: "https://platform.openai.com/docs/api-reference",
    builtin: false,
    endpoint: { kind: "editable", allowPrivateNetwork: true },
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
    endpoint: {
      kind: "editable",
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
    endpoint: {
      kind: "editable",
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
    endpoint: {
      kind: "editable",
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

/** 判断内置 Provider 是否需要用户配置地址。 */
export function providerHasEditableBaseURL(id: ProviderId): boolean {
  return getProvider(id).endpoint.kind === "editable";
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

/** 解析固定地址或用户覆盖后的 Provider 地址。 */
export function resolveProviderBaseURL(
  provider: ProviderId,
  override?: string,
): string {
  const endpoint = getProvider(provider).endpoint;
  if (endpoint.kind === "fixed") return endpoint.baseURL;
  return (override ?? endpoint.defaultBaseURL ?? "").trim();
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
