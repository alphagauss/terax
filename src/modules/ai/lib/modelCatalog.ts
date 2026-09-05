/**
 * 本文件通过 Provider 注册表发现远端模型 ID，并维护进程内 LRU。
 * 目录结果只用于辅助选择，不会自动加入用户配置或成为模型可用性的事实来源。
 */

import { createHttpFetch } from "@/lib/http";
import { normalizeModelId } from "../config";
import type { ResolvedProviderConnection } from "../providerRegistry";

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_CAPACITY = 16;
const MAX_PAGES = 10;
const MAX_MODELS = 10_000;

export type ModelCatalogErrorKind =
  | "auth"
  | "unsupported"
  | "http"
  | "invalid-response"
  | "network";

/** 模型目录请求失败，并保留 UI 可区分的稳定错误类别。 */
export class ModelCatalogError extends Error {
  constructor(
    readonly kind: ModelCatalogErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelCatalogError";
  }
}

type HttpResponse = {
  status: number;
  body: string;
};

export type CatalogRequest = {
  url: string;
  headers: Record<string, string>;
  allowPrivateNetwork: boolean;
};

type CatalogPage = {
  models: string[];
  nextPageToken: string | null;
};

type RequestFn = (request: CatalogRequest) => Promise<HttpResponse>;

type CacheEntry = {
  instanceId: string;
  models: string[];
  fetchedAt: number;
};

function catalogCacheKey(
  connection: ResolvedProviderConnection,
  credentialRevision: number,
): string {
  return JSON.stringify([
    connection.instanceId,
    connection.baseURL,
    credentialRevision,
  ]);
}

function endpointURL(baseURL: string, path: string): string {
  const base = baseURL.trim().replace(/\/+$/, "");
  if (!base) {
    throw new ModelCatalogError(
      "unsupported",
      "Model catalog endpoint is not configured",
    );
  }
  return `${base}/${path.replace(/^\/+/, "")}`;
}

function addQuery(
  url: string,
  values: Record<string, string | number | undefined>,
): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

function applyCatalogAuth(
  connection: ResolvedProviderConnection,
  url: string,
  headers: Record<string, string>,
): string {
  const credential = connection.credential;
  if (credential.adapter === "none") return url;
  const value = credential.value;
  if (!value) {
    if (credential.required) {
      throw new ModelCatalogError("auth", "API key is required");
    }
    return url;
  }
  switch (credential.catalogAuth.kind) {
    case "bearer":
      headers.Authorization = `Bearer ${value}`;
      return url;
    case "header":
      headers[credential.catalogAuth.name] = value;
      return url;
    case "query":
      return addQuery(url, { [credential.catalogAuth.name]: value });
  }
}

/** 根据已解析连接构造一页模型目录请求。 */
export function buildModelCatalogRequest(
  connection: ResolvedProviderConnection,
  pageToken?: string,
): CatalogRequest {
  const { catalog } = connection;
  const headers = { ...catalog.headers };
  let url = endpointURL(connection.baseURL, catalog.path);
  if (catalog.adapter === "google") {
    url = addQuery(url, { pageSize: 1000, pageToken });
  } else if (catalog.adapter === "anthropic") {
    url = addQuery(url, { limit: 1000, after_id: pageToken });
  }
  url = applyCatalogAuth(connection, url, headers);
  return {
    url,
    headers,
    allowPrivateNetwork: connection.allowPrivateNetwork,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeCatalogModelId(
  value: unknown,
  stripGooglePrefix: boolean,
): string | null {
  const model = asRecord(value);
  if (!model) return null;
  const rawId = stripGooglePrefix ? model.name : model.id;
  if (typeof rawId !== "string") return null;
  return normalizeModelId(
    stripGooglePrefix ? rawId.replace(/^models\//, "") : rawId,
  );
}

/** 校验并归一化一页 Provider 模型目录响应。 */
export function parseModelCatalogPage(
  adapter: ResolvedProviderConnection["catalog"]["adapter"],
  value: unknown,
): CatalogPage {
  const record = asRecord(value);
  const rawModels =
    adapter === "google" || adapter === "xai"
      ? record?.models
      : Array.isArray(value)
        ? value
        : record?.data;
  if (!Array.isArray(rawModels)) {
    throw new ModelCatalogError(
      "invalid-response",
      "Model catalog response does not contain a model list",
    );
  }
  const models = rawModels
    .map((model) => normalizeCatalogModelId(model, adapter === "google"))
    .filter((model): model is string => model !== null);
  if (rawModels.length > 0 && models.length === 0) {
    throw new ModelCatalogError(
      "invalid-response",
      "Model catalog entries do not contain valid IDs",
    );
  }
  const nextPageToken =
    adapter === "google"
      ? typeof record?.nextPageToken === "string"
        ? record.nextPageToken
        : null
      : adapter === "anthropic" && record?.has_more === true
        ? typeof record.last_id === "string"
          ? record.last_id
          : null
        : null;
  return { models, nextPageToken };
}

/** 通过公共 HTTP 边界获取有界模型目录正文。 */
async function invokeCatalogRequest(
  request: CatalogRequest,
): Promise<HttpResponse> {
  const response = await createHttpFetch({
    allowPrivateNetwork: request.allowPrivateNetwork,
    proxyMode: request.allowPrivateNetwork ? "direct" : "system",
  })(request.url, { headers: request.headers });
  return {
    status: response.status,
    body: await response.text(),
  };
}

function decodeJson(response: HttpResponse): unknown {
  if (response.status === 401 || response.status === 403) {
    throw new ModelCatalogError(
      "auth",
      "The provider rejected the API key",
      response.status,
    );
  }
  if (response.status === 404 || response.status === 405) {
    throw new ModelCatalogError(
      "unsupported",
      "The provider does not expose a model catalog",
      response.status,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ModelCatalogError(
      "http",
      `Model catalog request failed with HTTP ${response.status}`,
      response.status,
    );
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new ModelCatalogError(
      "invalid-response",
      "Model catalog response is not valid JSON",
      response.status,
    );
  }
}

/** 管理模型目录的 LRU、有效期和同一连接的并发请求合并。 */
export class ModelCatalog {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<string[]>>();
  private readonly credentialRevisions = new Map<string, number>();

  constructor(
    private readonly request: RequestFn = invokeCatalogRequest,
    private readonly now: () => number = Date.now,
  ) {}

  /** 获取一个 Provider 的模型目录；显式刷新会跳过成功结果缓存。 */
  list(
    connection: ResolvedProviderConnection,
    refresh = false,
  ): Promise<string[]> {
    const key = catalogCacheKey(
      connection,
      this.credentialRevisions.get(connection.instanceId) ?? 0,
    );
    const cached = this.cache.get(key);
    if (!refresh && cached && this.now() - cached.fetchedAt < CACHE_TTL_MS) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached.models);
    }
    const active = this.pending.get(key);
    if (active) return active;
    const promise = this.fetchAll(connection)
      .then((models) => {
        this.cache.delete(key);
        this.cache.set(key, {
          instanceId: connection.instanceId,
          models,
          fetchedAt: this.now(),
        });
        while (this.cache.size > CACHE_CAPACITY) {
          const oldest = this.cache.keys().next().value;
          if (typeof oldest !== "string") break;
          this.cache.delete(oldest);
        }
        return models;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  /** 使 Provider 实例的目录缓存失效，供地址或凭据变化后调用。 */
  invalidate(instanceId: string): void {
    this.credentialRevisions.set(
      instanceId,
      (this.credentialRevisions.get(instanceId) ?? 0) + 1,
    );
    for (const [key, entry] of this.cache) {
      if (entry.instanceId === instanceId) this.cache.delete(key);
    }
  }

  private async fetchAll(
    connection: ResolvedProviderConnection,
  ): Promise<string[]> {
    const models = new Set<string>();
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await this.request(
          buildModelCatalogRequest(connection, pageToken),
        );
        const parsed = parseModelCatalogPage(
          connection.catalog.adapter,
          decodeJson(response),
        );
        for (const model of parsed.models) {
          models.add(model);
          if (models.size >= MAX_MODELS) return [...models];
        }
        if (!parsed.nextPageToken) break;
        pageToken = parsed.nextPageToken;
      }
      return [...models];
    } catch (error) {
      if (error instanceof ModelCatalogError) throw error;
      throw new ModelCatalogError(
        "network",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export const modelCatalog = new ModelCatalog();
