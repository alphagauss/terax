/**
 * 本文件把 Alpha 证券详情转换为公共图表使用的市场元数据。
 * 同时提供价格精度、交易所时区和涨跌颜色等不依赖图表引擎的纯函数。
 */

import type {
  ChartMarketMetadata,
  MarketChartInterval,
  PriceColorConvention,
} from "@/modules/alpha/chart/model";

const MAX_PRICE_PRECISION = 8;

type SecurityMarketMetadataInput = {
  vt_symbol: string;
  name: string;
  exchange: string;
  timezone: string;
  price_tick: number | null;
  volume_unit: string | null;
  price_color_convention: PriceColorConvention;
};

/** 把正数最小价格跳动转换为最多八位的小数精度。 */
export function pricePrecisionFromMinMove(
  minMove: number | null,
): number | null {
  if (minMove === null || !Number.isFinite(minMove) || minMove <= 0) {
    return null;
  }
  for (let precision = 0; precision <= MAX_PRICE_PRECISION; precision += 1) {
    const scaled = minMove * 10 ** precision;
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 16;
    if (Math.abs(scaled - Math.round(scaled)) <= tolerance) return precision;
  }
  return MAX_PRICE_PRECISION;
}

/** 从证券详情构造图表引擎无关的静态市场语义。 */
export function createChartMarketMetadata(
  security: SecurityMarketMetadataInput,
  intervals: MarketChartInterval[],
): ChartMarketMetadata {
  const minMove =
    security.price_tick !== null &&
    Number.isFinite(security.price_tick) &&
    security.price_tick > 0
      ? security.price_tick
      : null;
  return {
    vtSymbol: security.vt_symbol,
    name: security.name,
    exchange: security.exchange,
    timezone: security.timezone,
    minMove,
    pricePrecision: pricePrecisionFromMinMove(minMove),
    volumeUnit: security.volume_unit,
    priceColorConvention: security.price_color_convention,
    intervals,
  };
}

/** 按市场约定把主题成功色和风险色映射为涨跌颜色。 */
export function marketDirectionColors(
  success: string,
  destructive: string,
  convention: PriceColorConvention,
): { up: string; down: string } {
  return convention === "up-red"
    ? { up: destructive, down: success }
    : { up: success, down: destructive };
}

/** 使用显式 IANA 时区格式化盘中时间，绝不读取 WebView 本地时区。 */
export function formatMarketTimestamp(
  epochSeconds: number,
  timezone: string,
  locale: string,
  style: "year" | "month" | "day" | "time" | "time-seconds" | "full",
): string {
  const date = new Date(epochSeconds * 1_000);
  const options: Intl.DateTimeFormatOptions =
    style === "year"
      ? { year: "numeric" }
      : style === "month"
        ? { month: "short" }
        : style === "day"
          ? { month: "2-digit", day: "2-digit" }
          : style === "time"
            ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
            : style === "time-seconds"
              ? {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hourCycle: "h23",
                }
              : {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  hourCycle: "h23",
                };
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone })
    .format(date)
    .replace(/^24:/, "00:");
}
