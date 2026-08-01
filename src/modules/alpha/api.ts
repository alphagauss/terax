/**
 * 本文件封装 Alpha 工作页面使用的业务查询。
 * 所有响应在前端边界完成校验，并继续通过 Rust 通用代理访问本机服务。
 */

import { requestAlpha, type AlphaQueryParam } from "@/modules/alpha/native";
import { z } from "zod";

const statusSchema = z.object({
  database_ready: z.boolean(),
  latest_trade_date: z.string().nullable(),
  security_count: z.number(),
});

const settingsSchema = z.object({
  data_dir: z.string().min(1),
});

const barCoverageSchema = z.object({
  rows: z.number(),
});

const dataOverviewSchema = z.object({
  total_bar_count: z.number(),
  bars: z.record(z.string(), barCoverageSchema),
});

const securitySchema = z.object({
  vt_symbol: z.string(),
  name: z.string(),
  product: z.string(),
  latest_bar_date: z.string().nullable(),
});

const securitiesSchema = z.object({
  items: z.array(securitySchema),
  total: z.number(),
});

const barSchema = z.object({
  time: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().nullable(),
});

const barsSchema = z.object({
  items: z.array(barSchema),
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
type AlphaDataOverview = z.infer<typeof dataOverviewSchema>;
export type AlphaSecurity = z.infer<typeof securitySchema>;
export type AlphaBar = z.infer<typeof barSchema>;
export type AlphaBacktest = z.infer<typeof backtestSchema>;
type AlphaBacktestSeries = {
  equity: z.infer<typeof equitySchema>["items"];
  drawdown: z.infer<typeof drawdownSchema>["items"];
};

export type AlphaSettings = {
  dataDir: string;
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
export function getAlphaDataOverview(): Promise<AlphaDataOverview> {
  return alphaGet("/api/alpha/data/overview", dataOverviewSchema);
}

/** 查询首批证券摘要，后续可直接扩展为服务端分页。 */
export function getAlphaSecurities(limit = 50): Promise<{
  items: AlphaSecurity[];
  total: number;
}> {
  return alphaGet("/api/alpha/securities", securitiesSchema, [
    { name: "limit", value: String(limit) },
  ]);
}

/** 查询单证券日 K 线，示例页限制最近 500 根。 */
export function getAlphaBars(vtSymbol: string): Promise<{
  items: AlphaBar[];
}> {
  return alphaGet("/api/alpha/bars", barsSchema, [
    { name: "vt_symbol", value: vtSymbol },
    { name: "interval", value: "d" },
    { name: "adjust", value: "forward" },
    { name: "limit", value: "500" },
  ]);
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
