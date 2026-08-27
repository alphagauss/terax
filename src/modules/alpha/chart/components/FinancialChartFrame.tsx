/**
 * 本文件实现 Alpha 公共金融图表的专业外壳。
 * 外壳负责图表类型、OHLC 信息、状态覆盖层和历史加载反馈，不拥有行情查询。
 */

import { FinancialChart } from "@/modules/alpha/chart/components/FinancialChart";
import type {
  FinancialChartStatus,
  FinancialChartType,
} from "@/modules/alpha/chart/model";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { MarketBar } from "@/modules/alpha/market/model";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  bars: readonly MarketBar[];
  dataKey: string;
  symbol: string | null;
  chartType: FinancialChartType;
  status: FinancialChartStatus;
  historyError: boolean;
  hasMoreBefore: boolean;
  loadingMore: boolean;
  visible: boolean;
  onChartTypeChange: (type: FinancialChartType) => void;
  onRequestMore: () => void;
  onRetry: () => void;
};

const CHART_TYPES: FinancialChartType[] = ["candlestick", "ohlc", "line"];

/** 渲染带工具栏、信息栏和状态反馈的公共金融图表。 */
export function FinancialChartFrame({
  bars,
  dataKey,
  symbol,
  chartType,
  status,
  historyError,
  hasMoreBefore,
  loadingMore,
  visible,
  onChartTypeChange,
  onRequestMore,
  onRetry,
}: Props) {
  const { t, i18n } = useTranslation("alpha");
  const [crosshair, setCrosshair] = useState<{
    dataKey: string;
    bar: MarketBar;
  } | null>(null);
  const latestBar = bars[bars.length - 1] ?? null;
  const displayBar = crosshair?.dataKey === dataKey ? crosshair.bar : latestBar;
  const number = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        maximumFractionDigits: 4,
      }),
    [i18n.language],
  );
  const compactNumber = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        notation: "compact",
        maximumFractionDigits: 2,
      }),
    [i18n.language],
  );
  const changePercent =
    displayBar && displayBar.open !== 0
      ? ((displayBar.close - displayBar.open) / displayBar.open) * 100
      : null;

  const handleCrosshairChange = useCallback(
    (bar: MarketBar | null) => {
      setCrosshair(bar ? { dataKey, bar } : null);
    },
    [dataKey],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-background/40">
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-border/60 px-2">
        <div className="flex min-w-0 items-center gap-1">
          {CHART_TYPES.map((type) => (
            <Button
              key={type}
              size="sm"
              variant={chartType === type ? "secondary" : "ghost"}
              className="h-7 px-2 text-[11px]"
              aria-pressed={chartType === type}
              onClick={() => onChartTypeChange(type)}
            >
              {t(`data.chart.types.${type}`)}
            </Button>
          ))}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {symbol ?? t("data.chart.title")}
        </div>
      </div>

      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-3 font-mono text-[10px] text-muted-foreground">
        <ChartValue
          label={t("data.chart.legend.open")}
          value={displayBar?.open}
          formatter={number}
        />
        <ChartValue
          label={t("data.chart.legend.high")}
          value={displayBar?.high}
          formatter={number}
        />
        <ChartValue
          label={t("data.chart.legend.low")}
          value={displayBar?.low}
          formatter={number}
        />
        <ChartValue
          label={t("data.chart.legend.close")}
          value={displayBar?.close}
          formatter={number}
        />
        <span
          className={cn(
            changePercent !== null &&
              (changePercent < 0 ? "text-destructive" : "text-success"),
          )}
        >
          {t("data.chart.legend.change")}{" "}
          {changePercent === null ? "-" : `${changePercent.toFixed(2)}%`}
        </span>
        <ChartValue
          label={t("data.chart.legend.volume")}
          value={displayBar?.volume}
          formatter={compactNumber}
        />
        <ChartValue
          label={t("data.chart.legend.amount")}
          value={displayBar?.amount}
          formatter={compactNumber}
        />
      </div>

      <div className="relative min-h-0 flex-1">
        <FinancialChart
          bars={bars}
          dataKey={dataKey}
          chartType={chartType}
          visible={visible}
          hasMoreBefore={hasMoreBefore}
          loadingMore={loadingMore}
          ariaLabel={t("data.chart.aria", {
            symbol: symbol ?? t("data.chart.title"),
          })}
          onCrosshairChange={handleCrosshairChange}
          onRequestMore={onRequestMore}
        />
        {status !== "ready" ? (
          <ChartStatusOverlay status={status} onRetry={onRetry} />
        ) : null}
        {loadingMore ? (
          <div className="absolute left-2 top-2 flex items-center gap-1 rounded bg-background/85 px-2 py-1 text-[10px] text-muted-foreground shadow-sm">
            <Spinner className="size-3" />
            {t("data.chart.loadingHistory")}
          </div>
        ) : null}
        {status === "ready" && !hasMoreBefore && !historyError ? (
          <div className="absolute bottom-2 left-2 rounded bg-background/85 px-2 py-1 text-[10px] text-muted-foreground shadow-sm">
            {t("data.chart.earliest")}
          </div>
        ) : null}
        {historyError ? (
          <Button
            size="sm"
            variant="outline"
            className="absolute bottom-2 left-2 h-7 bg-background/90 text-[10px]"
            onClick={onRequestMore}
          >
            {t("data.chart.historyRetry")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ChartValue({
  label,
  value,
  formatter,
}: {
  label: string;
  value: number | null | undefined;
  formatter: Intl.NumberFormat;
}) {
  return (
    <span>
      {label}{" "}
      {value === null || value === undefined ? "-" : formatter.format(value)}
    </span>
  );
}

function ChartStatusOverlay({
  status,
  onRetry,
}: {
  status: Exclude<FinancialChartStatus, "ready">;
  onRetry: () => void;
}) {
  const { t } = useTranslation("alpha");
  const label =
    status === "idle"
      ? t("data.chart.empty")
      : status === "error"
        ? t("data.chart.error")
        : t(`data.chart.status.${status}`);
  return (
    <div className="absolute inset-0 grid place-items-center bg-background/75 px-6 text-center text-xs text-muted-foreground backdrop-blur-[1px]">
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2">
          {status === "loading" ? <Spinner className="size-3.5" /> : null}
          {label}
        </div>
        {status === "error" ? (
          <Button size="sm" variant="outline" className="h-7" onClick={onRetry}>
            {t("data.chart.retry")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
