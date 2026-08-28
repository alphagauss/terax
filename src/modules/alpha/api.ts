/**
 * 本文件封装 Alpha 工作页面使用的业务查询。
 * 所有响应在前端边界完成校验，并继续通过 Rust 通用代理访问本机服务。
 */

import type {
  MarketAdjust,
  MarketBarPage,
  MarketInterval,
} from "@/modules/alpha/market/model";
import {
  normalizeMarketBars,
  normalizeMarketTime,
} from "@/modules/alpha/market/normalize";
import { type AlphaQueryParam, requestAlpha } from "@/modules/alpha/native";
import { z } from "zod";

const statusSchema = z.object({
  database_ready: z.boolean(),
  latest_trade_date: z.string().nullable(),
  security_count: z.number(),
});

const settingsSchema = z.object({
  data_dir: z.string().min(1),
});

const facetCountSchema = z.object({
  value: z.string(),
  count: z.number(),
});

const intervalFacetSchema = z.object({
  value: z.string(),
  security_count: z.number(),
  row_count: z.number(),
});

const dataOverviewSchema = z.object({
  summary: z.object({
    security_count: z.number(),
    profile_count: z.number(),
    bar_security_count: z.number(),
    total_bar_count: z.number(),
    data_start: z.string().nullable(),
    data_end: z.string().nullable(),
    latest_updated_at: z.string().nullable(),
  }),
  facets: z.object({
    exchanges: z.array(facetCountSchema),
    asset_types: z.array(facetCountSchema),
    data_states: z.array(facetCountSchema),
    intervals: z.array(intervalFacetSchema),
  }),
});

const barCoverageSchema = z.object({
  start: z.string(),
  end: z.string(),
  rows: z.number(),
  updated_at: z.string(),
});

const securitySchema = z.object({
  vt_symbol: z.string(),
  symbol: z.string(),
  exchange: z.string(),
  name: z.string(),
  asset_type: z.string().nullable(),
  board: z.number().nullable(),
  listed_date: z.string().nullable(),
  delisted_date: z.string().nullable(),
  status: z.enum(["active", "delisted"]),
  data_state: z.enum(["complete", "profile_only", "bars_only"]),
  total_bar_count: z.number(),
  data_start: z.string().nullable(),
  data_end: z.string().nullable(),
  latest_updated_at: z.string().nullable(),
  intervals: z.array(z.string()),
  coverage: z.record(z.string(), barCoverageSchema),
});

const securitiesSchema = z.object({
  items: z.array(securitySchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

const securityDetailSchema = securitySchema.extend({
  timezone: z.string().min(1),
  price_color_convention: z.enum(["up-red", "up-green"]),
  volume_unit: z.string().nullable(),
  price_tick: z.number().nullable(),
});

const barSchema = z.object({
  time: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().nullable(),
  amount: z.number().nullable(),
  open_interest: z.number().nullable().optional().default(null),
});

const barsSchema = z.object({
  items: z.array(barSchema),
  has_more_before: z.boolean(),
  next_before: z.string().nullable(),
  actual_start: z.string().nullable(),
  actual_end: z.string().nullable(),
  reference_close: z.number().nullable(),
  reference_time: z.string().nullable(),
});

const syncTaskSchema = z.object({
  task_id: z.string().min(1),
  status: z.string(),
  created_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  message: z.string().nullable(),
});

const syncQualityIssueSchema = z.object({
  vt_symbol: z.string(),
  trade_date: z.string(),
  field: z.string(),
  kind: z.string(),
  message: z.string(),
  db_value: z.number().nullable(),
  fetched_value: z.number().nullable(),
});

const syncQualitySchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(["healthy", "issues", "failed"]),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  latest_trade_date: z.string().nullable(),
  planned_symbol_count: z.number(),
  fetched_rows: z.number(),
  saved_rows: z.number(),
  failed_batch_count: z.number(),
  validation_issue_count: z.number(),
  failed_vt_symbols: z.array(z.string()).max(500),
  failed_vt_symbol_count: z.number(),
  issues: z.array(syncQualityIssueSchema).max(100),
  message: z.string().nullable().optional().default(null),
});

const syncOverviewSchema = z.object({
  tasks: z.array(syncTaskSchema),
  latest: syncQualitySchema.nullable(),
});

const syncStartSchema = z.object({
  task_id: z.string().min(1),
  status: z.string(),
});

const backtestSchema = z.object({
  id: z.string(),
  name: z.string(),
  strategy_name: z.string(),
  status: z.string(),
  total_return: z.number().nullable(),
  max_drawdown: z.number().nullable(),
  sharpe: z.number().nullable(),
  trade_count: z.number().nullable(),
  created_at: z.string().nullable(),
});

const backtestsSchema = z.object({
  items: z.array(backtestSchema),
  total: z.number(),
});

const equitySchema = z.object({
  items: z.array(
    z.object({
      date: z.string().nullable(),
      equity: z.number().nullable(),
    }),
  ),
});

const drawdownSchema = z.object({
  items: z.array(
    z.object({
      date: z.string().nullable(),
      drawdown: z.number().nullable(),
    }),
  ),
});

type AlphaStatusOverview = z.infer<typeof statusSchema>;
export type AlphaDataOverview = z.infer<typeof dataOverviewSchema>;
export type AlphaSecurity = z.infer<typeof securitySchema>;
export type AlphaSecurityDetail = z.infer<typeof securityDetailSchema>;
export type AlphaSyncOverview = z.infer<typeof syncOverviewSchema>;
export type AlphaBacktest = z.infer<typeof backtestSchema>;
type AlphaBacktestSeries = {
  equity: z.infer<typeof equitySchema>["items"];
  drawdown: z.infer<typeof drawdownSchema>["items"];
};

export type AlphaSettings = {
  dataDir: string;
};

export type AlphaSecurityQuery = {
  q?: string;
  exchange?: string;
  assetType?: string;
  dataState?: AlphaSecurity["data_state"];
  interval?: string;
  limit?: number;
  offset?: number;
};

export type AlphaBarQuery = {
  interval?: MarketInterval;
  adjust?: MarketAdjust;
  start?: string;
  end?: string;
  before?: string;
  limit?: number;
};

function alphaError(status: number, body: unknown): Error {
  const detail =
    body && typeof body === "object" && "detail" in body
      ? String(body.detail)
      : JSON.stringify(body);
  return new Error(`Alpha ${status}: ${detail}`);
}

/**
 * 发送 Alpha GET 请求并校验响应。
 *
 * FastAPI 业务错误保留状态码和响应内容，便于工作页面展示真实失败原因。
 */
async function alphaGet<T>(
  path: `/api/alpha${string}`,
  schema: z.ZodType<T>,
  query: AlphaQueryParam[] = [],
): Promise<T> {
  const response = await requestAlpha({
    method: "GET",
    path,
    query,
  });
  if (response.status < 200 || response.status >= 300) {
    throw alphaError(response.status, response.body);
  }
  return schema.parse(response.body);
}

/** 查询 Alpha 持久配置。 */
export async function getAlphaSettings(): Promise<AlphaSettings> {
  const settings = await alphaGet("/api/alpha/settings", settingsSchema);
  return { dataDir: settings.data_dir };
}

/** 保存 Alpha 持久配置，资源重建由设置页随后触发。 */
export async function updateAlphaSettings(
  settings: AlphaSettings,
): Promise<AlphaSettings> {
  const response = await requestAlpha({
    method: "POST",
    path: "/api/alpha/settings",
    body: { data_dir: settings.dataDir },
  });
  if (response.status < 200 || response.status >= 300) {
    throw alphaError(response.status, response.body);
  }
  const saved = settingsSchema.parse(response.body);
  return { dataDir: saved.data_dir };
}

/** 查询 Alpha 数据库和业务摘要。 */
export function getAlphaOverview(): Promise<AlphaStatusOverview> {
  return alphaGet("/api/alpha/status", statusSchema);
}

/** 查询行情数据覆盖概览。 */
export function getAlphaDataOverview(
  forceRefresh = false,
): Promise<AlphaDataOverview> {
  return alphaGet(
    "/api/alpha/data/overview",
    dataOverviewSchema,
    forceRefresh ? [{ name: "force_refresh", value: "true" }] : [],
  );
}

/** 查询运行中的日线同步和最近一次结构化质量结果。 */
export function getAlphaSyncOverview(): Promise<AlphaSyncOverview> {
  return alphaGet("/api/alpha/sync/overview", syncOverviewSchema);
}

/** 启动全量增量同步，传入标的时只重试该有界集合。 */
export async function startAlphaBarSync(
  vtSymbols?: readonly string[],
): Promise<z.infer<typeof syncStartSchema>> {
  const response = await requestAlpha({
    method: "POST",
    path: "/api/alpha/sync/bars",
    body: vtSymbols ? { vt_symbols: [...vtSymbols] } : {},
  });
  if (response.status < 200 || response.status >= 300) {
    throw alphaError(response.status, response.body);
  }
  return syncStartSchema.parse(response.body);
}

/** 按搜索和 Facet 条件查询证券数据目录分页。 */
export function getAlphaSecurities(query: AlphaSecurityQuery = {}): Promise<{
  items: AlphaSecurity[];
  total: number;
  limit: number;
  offset: number;
}> {
  const params: AlphaQueryParam[] = [];
  const append = (name: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "") {
      params.push({ name, value: String(value) });
    }
  };
  append("q", query.q?.trim());
  append("exchange", query.exchange);
  append("asset_type", query.assetType);
  append("data_state", query.dataState);
  append("interval", query.interval);
  append("limit", query.limit ?? 50);
  append("offset", query.offset ?? 0);
  return alphaGet("/api/alpha/securities", securitiesSchema, params);
}

/** 读取单个证券的权威目录和图表市场元数据。 */
export function getAlphaSecurity(
  vtSymbol: string,
): Promise<AlphaSecurityDetail> {
  return alphaGet(
    `/api/alpha/securities/${encodeURIComponent(vtSymbol)}`,
    securityDetailSchema,
  );
}

/** 查询单证券 K 线，并在 API 边界归一化为图表引擎无关模型。 */
export async function getAlphaBars(
  vtSymbol: string,
  query: AlphaBarQuery = {},
): Promise<MarketBarPage> {
  const interval = query.interval ?? "d";
  const params: AlphaQueryParam[] = [
    { name: "vt_symbol", value: vtSymbol },
    { name: "interval", value: interval },
    { name: "adjust", value: query.adjust ?? "forward" },
    { name: "limit", value: String(query.limit ?? 500) },
  ];
  for (const [name, value] of [
    ["start", query.start],
    ["end", query.end],
    ["before", query.before],
  ] as const) {
    if (value) params.push({ name, value });
  }
  const response = await alphaGet("/api/alpha/bars", barsSchema, params);
  return {
    items: normalizeMarketBars(
      response.items.map((item) => ({
        ...item,
        openInterest: item.open_interest,
      })),
      interval,
    ),
    hasMoreBefore: response.has_more_before,
    nextBefore: response.next_before,
    actualStart: response.actual_start,
    actualEnd: response.actual_end,
    referenceClose: response.reference_close,
    referenceTime: response.reference_time
      ? normalizeMarketTime(
          response.reference_time,
          /^\d{4}-\d{2}-\d{2}$/.test(response.reference_time) ? "d" : interval,
        )
      : null,
  };
}

/** 查询最近回测和运行中任务。 */
export function getAlphaBacktests(limit = 50): Promise<{
  items: AlphaBacktest[];
  total: number;
}> {
  return alphaGet("/api/alpha/backtests", backtestsSchema, [
    { name: "limit", value: String(limit) },
  ]);
}

/** 并行查询已完成回测的净值与回撤序列。 */
export async function getAlphaBacktestSeries(
  backtestId: string,
): Promise<AlphaBacktestSeries> {
  const pathId = encodeURIComponent(backtestId);
  const [equity, drawdown] = await Promise.all([
    alphaGet(`/api/alpha/backtests/${pathId}/equity`, equitySchema),
    alphaGet(`/api/alpha/backtests/${pathId}/drawdown`, drawdownSchema),
  ]);
  return { equity: equity.items, drawdown: drawdown.items };
}
