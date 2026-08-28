/**
 * 本文件实现 Alpha 公共金融图表的专业外壳。
 * 外壳负责受控周期、复权、图表类型、OHLC 信息和状态反馈，不拥有行情查询。
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { FinancialChart } from "@/modules/alpha/chart/components/FinancialChart";
import type {
  FinancialChartStatus,
  MarketChartDensity,
  MarketChartInterval,
  MarketChartOptions,
} from "@/modules/alpha/chart/model";
import { FINANCIAL_CHART_TYPES } from "@/modules/alpha/chart/model";
import type { MarketBar } from "@/modules/alpha/market/model";
import { MARKET_ADJUSTMENTS } from "@/modules/alpha/market/model";
import { marketTimeKey } from "@/modules/alpha/market/normalize";
import { FitToScreenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  bars: readonly MarketBar[];
  dataKey: string;
  symbol: string | null;
  options: MarketChartOptions;
  availableIntervals: readonly MarketChartInterval[];
  density: MarketChartDensity;
  status: FinancialChartStatus;
  historyError: boolean;
  hasMoreBefore: boolean;
  loadingMore: boolean;
  visible: boolean;
  onOptionsChange: (options: MarketChartOptions) => void;
  onRequestMore: () => void;
  onRetry: () => void;
};

/** 根据使用密度渲染受控工具栏、信息栏和状态反馈。 */
export function FinancialChartFrame({
  bars,
  dataKey,
  symbol,
  options,
  availableIntervals,
  density,
  status,
  historyError,
  hasMoreBefore,
  loadingMore,
  visible,
  onOptionsChange,
  onRequestMore,
  onRetry,
}: Props) {
  const { t, i18n } = useTranslation("alpha");
  const [crosshair, setCrosshair] = useState<{
    dataKey: string;
    bar: MarketBar;
  } | null>(null);
  const [resetRevision, setResetRevision] = useState(0);
  const latestBar = bars[bars.length - 1] ?? null;
  const displayBar = crosshair?.dataKey === dataKey ? crosshair.bar : latestBar;
  const previousCloseByTime = useMemo(
    () =>
      new Map(
        bars.map((bar, index) => [
          marketTimeKey(bar.time),
          index > 0 ? bars[index - 1]?.close : null,
        ]),
      ),
    [bars],
  );
  const previousClose = displayBar
    ? (previousCloseByTime.get(marketTimeKey(displayBar.time)) ?? null)
    : null;
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
    displayBar && previousClose !== null && previousClose !== 0
      ? ((displayBar.close - previousClose) / previousClose) * 100
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
          {density === "panel" ? (
            <>
              <Select
                value={options.interval}
                onValueChange={(value) => {
                  const interval = availableIntervals.find(
                    (candidate) => candidate === value,
                  );
                  if (interval) onOptionsChange({ ...options, interval });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="h-7 min-w-14 rounded-md px-2 text-[11px]"
                  title={t("data.chart.controls.interval")}
                  aria-label={t("data.chart.controls.interval")}
                >
                  <SelectValue>
                    {t(`data.chart.intervals.${options.interval}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {availableIntervals.map((interval) => (
                    <SelectItem key={interval} value={interval}>
                      {t(`data.chart.intervals.${interval}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={options.adjust}
                onValueChange={(value) => {
                  const adjust = MARKET_ADJUSTMENTS.find(
                    (candidate) => candidate === value,
                  );
                  if (adjust) onOptionsChange({ ...options, adjust });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="h-7 min-w-16 rounded-md px-2 text-[11px]"
                  title={t("data.chart.controls.adjust")}
                  aria-label={t("data.chart.controls.adjust")}
                >
                  <SelectValue>
                    {t(`data.chart.adjustments.${options.adjust}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {MARKET_ADJUSTMENTS.map((adjust) => (
                    <SelectItem key={adjust} value={adjust}>
                      {t(`data.chart.adjustments.${adjust}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={options.chartType}
                onValueChange={(value) => {
                  const chartType = FINANCIAL_CHART_TYPES.find(
                    (candidate) => candidate === value,
                  );
                  if (chartType) onOptionsChange({ ...options, chartType });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="h-7 min-w-18 rounded-md px-2 text-[11px]"
                  title={t("data.chart.controls.chartType")}
                  aria-label={t("data.chart.controls.chartType")}
                >
                  <SelectValue>
                    {t(`data.chart.types.${options.chartType}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {FINANCIAL_CHART_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`data.chart.types.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : (
            FINANCIAL_CHART_TYPES.map((type) => (
              <Button
                key={type}
                size="sm"
                variant={options.chartType === type ? "secondary" : "ghost"}
                className="h-7 px-2 text-[11px]"
                aria-pressed={options.chartType === type}
                onClick={() => onOptionsChange({ ...options, chartType: type })}
              >
                {t(`data.chart.types.${type}`)}
              </Button>
            ))
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            title={t("data.chart.resetView")}
            aria-label={t("data.chart.resetView")}
            onClick={() => setResetRevision((revision) => revision + 1)}
          >
            <HugeiconsIcon icon={FitToScreenIcon} size={13} strokeWidth={1.8} />
          </Button>
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
          chartType={options.chartType}
          visible={visible}
          hasMoreBefore={hasMoreBefore}
          loadingMore={loadingMore}
          resetRevision={resetRevision}
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
