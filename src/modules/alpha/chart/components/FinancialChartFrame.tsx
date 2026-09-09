/**
 * 本文件实现 Alpha 公共金融图表的专业外壳。
 * 外壳负责受控图表选项、价格、指标与对比 legend、可选同步桥、懒加载管理入口、导出和状态反馈，不拥有查询。
 */

import { Hint } from "@/components/controls/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Button } from "@/components/controls/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { ChartAccessibilityLayer } from "@/modules/alpha/chart/accessibility/ChartAccessibilityLayer";
import { ComparisonLegend } from "@/modules/alpha/chart/comparison/ComparisonLegend";
import { latestChartComparisonValues } from "@/modules/alpha/chart/comparison/normalize";
import {
  FinancialChart,
  type FinancialChartHandle,
} from "@/modules/alpha/chart/components/FinancialChart";
import type { ChartStudyLegendValues } from "@/modules/alpha/chart/controller/FinancialChartController";
import {
  buildChartExportFilename,
  buildMarketBarsCsv,
  downloadChartBlob,
  downloadChartPng,
  MAX_CHART_EXPORT_BARS,
} from "@/modules/alpha/chart/export/chartExport";
import { latestChartStudyValues } from "@/modules/alpha/chart/lightweight/studies";
import type {
  ChartComparisonConfig,
  ChartComparisonLegendValues,
  ChartComparisonSeries,
  ChartComparisonState,
  ChartMarketMetadata,
  ChartPriceReference,
  FinancialChartStatus,
  MarketChartDensity,
  MarketChartInterval,
  MarketChartOptions,
} from "@/modules/alpha/chart/model";
import { FINANCIAL_CHART_TYPES } from "@/modules/alpha/chart/model";
import type {
  ChartStudyInstance,
  ChartStudyResult,
} from "@/modules/alpha/chart/studies/model";
import { StudyLegend } from "@/modules/alpha/chart/studies/StudyLegend";
import type { FinancialChartSyncRuntime } from "@/modules/alpha/chart/sync/ChartSyncContext";
import { formatMarketTimestamp } from "@/modules/alpha/market/metadata";
import type { MarketBar, MarketTime } from "@/modules/alpha/market/model";
import { MARKET_ADJUSTMENTS } from "@/modules/alpha/market/model";
import { marketTimeKey } from "@/modules/alpha/market/normalize";
import type {
  MarketDataRuntime,
  MarketRealtimeState,
} from "@/modules/alpha/realtime/model";
import {
  ChartLineData01Icon,
  ChartRelationshipIcon,
  Download01Icon,
  FitToScreenIcon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

type Props = {
  bars: readonly MarketBar[];
  dataKey: string;
  symbol: string | null;
  options: MarketChartOptions;
  metadata: ChartMarketMetadata | null;
  priceReference: ChartPriceReference;
  availableIntervals: readonly MarketChartInterval[];
  density: MarketChartDensity;
  status: FinancialChartStatus;
  historyError: boolean;
  hasMoreBefore: boolean;
  loadingMore: boolean;
  visible: boolean;
  studies?: readonly ChartStudyInstance[];
  studyResults?: readonly ChartStudyResult[];
  studyLoading?: boolean;
  studyError?: boolean;
  comparisons?: readonly ChartComparisonConfig[];
  comparisonStates?: readonly ChartComparisonState[];
  comparisonSeries?: readonly ChartComparisonSeries[];
  syncRuntime?: FinancialChartSyncRuntime | null;
  realtimeRuntime?: MarketDataRuntime | null;
  realtimeState?: MarketRealtimeState | null;
  realtimeEnabled?: boolean;
  onOptionsChange: (options: MarketChartOptions) => void;
  onStudiesChange?: (studies: ChartStudyInstance[]) => void;
  onComparisonsChange?: (comparisons: ChartComparisonConfig[]) => void;
  onRetryComparison?: (vtSymbol: string) => void;
  onRealtimeEnabledChange?: (enabled: boolean) => void;
  onRequestMore: () => void;
  onRetry: () => void;
};

const EMPTY_STUDIES: readonly ChartStudyInstance[] = [];
const EMPTY_STUDY_RESULTS: readonly ChartStudyResult[] = [];
const EMPTY_COMPARISONS: readonly ChartComparisonConfig[] = [];
const EMPTY_COMPARISON_STATES: readonly ChartComparisonState[] = [];
const EMPTY_COMPARISON_SERIES: readonly ChartComparisonSeries[] = [];
const IndicatorDialog = lazy(
  () => import("@/modules/alpha/chart/studies/IndicatorDialog"),
);
const ComparisonDialog = lazy(
  () => import("@/modules/alpha/chart/comparison/ComparisonDialog"),
);

/** 根据使用密度渲染受控工具栏、信息栏和状态反馈。 */
export function FinancialChartFrame({
  bars,
  dataKey,
  symbol,
  options,
  metadata,
  priceReference,
  availableIntervals,
  density,
  status,
  historyError,
  hasMoreBefore,
  loadingMore,
  visible,
  studies = EMPTY_STUDIES,
  studyResults = EMPTY_STUDY_RESULTS,
  studyLoading = false,
  studyError = false,
  comparisons = EMPTY_COMPARISONS,
  comparisonStates = EMPTY_COMPARISON_STATES,
  comparisonSeries = EMPTY_COMPARISON_SERIES,
  syncRuntime = null,
  realtimeRuntime = null,
  realtimeState = null,
  realtimeEnabled = false,
  onOptionsChange,
  onStudiesChange,
  onComparisonsChange,
  onRetryComparison,
  onRealtimeEnabledChange,
  onRequestMore,
  onRetry,
}: Props) {
  const { t, i18n } = useTranslation("alpha");
  const [crosshair, setCrosshair] = useState<{
    dataKey: string;
    bar: MarketBar;
    studyValues: ChartStudyLegendValues;
    comparisonValues: ChartComparisonLegendValues;
  } | null>(null);
  const [indicatorDialogOpen, setIndicatorDialogOpen] = useState(false);
  const [editingStudyId, setEditingStudyId] = useState<string | null>(null);
  const [comparisonDialogOpen, setComparisonDialogOpen] = useState(false);
  const [liveBar, setLiveBar] = useState<{
    dataKey: string;
    bar: MarketBar;
  } | null>(null);
  const [followingLatest, setFollowingLatest] = useState<{
    dataKey: string;
    value: boolean;
  } | null>(null);
  const chartRef = useRef<FinancialChartHandle>(null);
  const latestBar =
    liveBar?.dataKey === dataKey
      ? liveBar.bar
      : (bars[bars.length - 1] ?? null);
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
    ? marketTimeKey(displayBar.time) ===
      (latestBar ? marketTimeKey(latestBar.time) : null)
      ? priceReference.previousClose
      : (previousCloseByTime.get(marketTimeKey(displayBar.time)) ?? null)
    : null;
  const pricePrecision = metadata?.pricePrecision ?? 2;
  const number = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        minimumFractionDigits: pricePrecision,
        maximumFractionDigits: pricePrecision,
      }),
    [i18n.language, pricePrecision],
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
  const changeClass =
    changePercent === null
      ? undefined
      : metadata?.priceColorConvention === "up-red"
        ? changePercent < 0
          ? "text-success"
          : "text-destructive"
        : changePercent < 0
          ? "text-destructive"
          : "text-success";
  const volumeUnit =
    metadata?.volumeUnit === "share"
      ? t("data.chart.units.share")
      : metadata?.volumeUnit;
  const formatTime = useCallback(
    (time: MarketTime) =>
      time.kind === "trading-day"
        ? time.date
        : formatMarketTimestamp(
            time.epochSeconds,
            metadata?.timezone ?? "UTC",
            i18n.language,
            "full",
          ),
    [i18n.language, metadata?.timezone],
  );
  const formatPrice = useCallback(
    (value: number) => number.format(value),
    [number],
  );
  const formatVolume = useCallback(
    (value: number | null) =>
      value === null ? "-" : compactNumber.format(value),
    [compactNumber],
  );
  const accessibilitySummary = displayBar
    ? t("data.chart.accessibility.summary", {
        symbol: symbol ?? t("data.chart.title"),
        time: formatTime(displayBar.time),
        open: formatPrice(displayBar.open),
        high: formatPrice(displayBar.high),
        low: formatPrice(displayBar.low),
        close: formatPrice(displayBar.close),
        volume: formatVolume(displayBar.volume),
      })
    : t("data.chart.accessibility.noData", {
        symbol: symbol ?? t("data.chart.title"),
      });
  const latestStudyValues = useMemo(
    () => latestChartStudyValues(studyResults),
    [studyResults],
  );
  const displayedStudyValues =
    crosshair?.dataKey === dataKey ? crosshair.studyValues : latestStudyValues;
  const latestComparisonValues = useMemo(
    () => latestChartComparisonValues(comparisonSeries),
    [comparisonSeries],
  );
  const displayedComparisonValues =
    crosshair?.dataKey === dataKey
      ? crosshair.comparisonValues
      : latestComparisonValues;

  const handleCrosshairChange = useCallback(
    (
      bar: MarketBar | null,
      studyValues: ChartStudyLegendValues,
      comparisonValues: ChartComparisonLegendValues,
    ) => {
      setCrosshair(
        bar ? { dataKey, bar, studyValues, comparisonValues } : null,
      );
    },
    [dataKey],
  );

  const handlePngExport = useCallback(() => {
    try {
      const screenshot = chartRef.current?.takeScreenshot();
      if (!screenshot) throw new Error("chart-screenshot-unavailable");
      void downloadChartPng(
        screenshot,
        buildChartExportFilename(symbol, options.interval, "png"),
      ).catch(() => toast.error(t("data.chart.export.pngFailed")));
    } catch {
      toast.error(t("data.chart.export.pngFailed"));
    }
  }, [options.interval, symbol, t]);

  const handleCsvExport = useCallback(() => {
    if (bars.length > MAX_CHART_EXPORT_BARS) {
      toast.error(
        t("data.chart.export.tooManyBars", {
          limit: MAX_CHART_EXPORT_BARS.toLocaleString(i18n.language),
        }),
      );
      return;
    }
    try {
      const csv = buildMarketBarsCsv(bars);
      downloadChartBlob(
        new Blob([csv], { type: "text/csv;charset=utf-8" }),
        buildChartExportFilename(symbol, options.interval, "csv"),
      );
    } catch {
      toast.error(t("data.chart.export.csvFailed"));
    }
  }, [bars, i18n.language, options.interval, symbol, t]);

  const toggleStudy = useCallback(
    (instanceId: string) => {
      onStudiesChange?.(
        studies.map((study) =>
          study.instanceId === instanceId
            ? { ...study, visible: !study.visible }
            : study,
        ),
      );
    },
    [onStudiesChange, studies],
  );
  const removeStudy = useCallback(
    (instanceId: string) => {
      onStudiesChange?.(
        studies.filter((study) => study.instanceId !== instanceId),
      );
    },
    [onStudiesChange, studies],
  );
  const moveStudy = useCallback(
    (instanceId: string, direction: -1 | 1) => {
      const index = studies.findIndex(
        (study) => study.instanceId === instanceId,
      );
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= studies.length) return;
      const next = [...studies];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      onStudiesChange?.(next);
    },
    [onStudiesChange, studies],
  );
  const editStudy = useCallback((instanceId: string) => {
    setEditingStudyId(instanceId);
    setIndicatorDialogOpen(true);
  }, []);

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
                <Hint content={t("data.chart.controls.interval")}>
                  <SelectTrigger
                    size="sm"
                    className="min-w-14 px-2"
                    aria-label={t("data.chart.controls.interval")}
                  >
                    <SelectValue>
                      {t(`data.chart.intervals.${options.interval}`)}
                    </SelectValue>
                  </SelectTrigger>
                </Hint>
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
                <Hint content={t("data.chart.controls.adjust")}>
                  <SelectTrigger
                    size="sm"
                    className="min-w-16 px-2"
                    aria-label={t("data.chart.controls.adjust")}
                  >
                    <SelectValue>
                      {t(`data.chart.adjustments.${options.adjust}`)}
                    </SelectValue>
                  </SelectTrigger>
                </Hint>
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
                <Hint content={t("data.chart.controls.chartType")}>
                  <SelectTrigger
                    size="sm"
                    className="min-w-18 px-2"
                    aria-label={t("data.chart.controls.chartType")}
                  >
                    <SelectValue>
                      {t(`data.chart.types.${options.chartType}`)}
                    </SelectValue>
                  </SelectTrigger>
                </Hint>
                <SelectContent>
                  {FINANCIAL_CHART_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`data.chart.types.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Hint content={t("data.chart.controls.volume")}>
                <Button
                  type="button"
                  size="sm"
                  variant={options.showVolume ? "secondary" : "ghost"}
                  aria-label={t("data.chart.controls.volume")}
                  aria-pressed={options.showVolume}
                  onClick={() =>
                    onOptionsChange({
                      ...options,
                      showVolume: !options.showVolume,
                    })
                  }
                >
                  {t("data.chart.legend.volume")}
                </Button>
              </Hint>
              {onStudiesChange ? (
                <Hint content={t("data.chart.studies.open")}>
                  <Button
                    type="button"
                    size="sm"
                    variant={studies.length > 0 ? "secondary" : "ghost"}
                    className="gap-1"
                    aria-label={t("data.chart.studies.open")}
                    onClick={() => {
                      setEditingStudyId(null);
                      setIndicatorDialogOpen(true);
                    }}
                  >
                    <HugeiconsIcon
                      icon={ChartLineData01Icon}
                      size={12}
                      strokeWidth={1.8}
                    />
                    {t("data.chart.studies.label")}
                    {studies.length > 0 ? ` ${studies.length}` : ""}
                  </Button>
                </Hint>
              ) : null}
            </>
          ) : (
            FINANCIAL_CHART_TYPES.map((type) => (
              <Button
                key={type}
                size="sm"
                variant={options.chartType === type ? "secondary" : "ghost"}
                aria-pressed={options.chartType === type}
                onClick={() => onOptionsChange({ ...options, chartType: type })}
              >
                {t(`data.chart.types.${type}`)}
              </Button>
            ))
          )}
          <Hint content={t("data.chart.resetView")}>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("data.chart.resetView")}
              onClick={() => chartRef.current?.resetView()}
            >
              <HugeiconsIcon
                icon={FitToScreenIcon}
                size={13}
                strokeWidth={1.8}
              />
            </Button>
          </Hint>
          {density === "panel" ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Hint content={t("data.chart.actions.menu")}>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("data.chart.actions.menu")}
                  >
                    <HugeiconsIcon
                      icon={MoreHorizontalIcon}
                      size={13}
                      strokeWidth={1.8}
                    />
                  </Button>
                </Hint>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {onComparisonsChange ? (
                  <DropdownMenuItem
                    onSelect={() => setComparisonDialogOpen(true)}
                  >
                    <HugeiconsIcon
                      icon={ChartRelationshipIcon}
                      size={13}
                      strokeWidth={1.8}
                    />
                    {t("data.chart.comparisons.open")}
                    {comparisons.length > 0 ? ` (${comparisons.length})` : ""}
                  </DropdownMenuItem>
                ) : null}
                {onRealtimeEnabledChange ? (
                  <DropdownMenuItem
                    onSelect={() => onRealtimeEnabledChange(!realtimeEnabled)}
                  >
                    {realtimeEnabled
                      ? t("data.chart.realtime.disable")
                      : t("data.chart.realtime.enable")}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={bars.length === 0}
                  onSelect={handlePngExport}
                >
                  <HugeiconsIcon
                    icon={Download01Icon}
                    size={13}
                    strokeWidth={1.8}
                  />
                  {t("data.chart.export.png")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={bars.length === 0}
                  onSelect={handleCsvExport}
                >
                  <HugeiconsIcon
                    icon={Download01Icon}
                    size={13}
                    strokeWidth={1.8}
                  />
                  {t("data.chart.export.csv")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          <span>{symbol ?? t("data.chart.title")}</span>
          {realtimeEnabled ? (
            <span
              className="ml-2 inline-flex items-center gap-1"
              aria-live="polite"
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  realtimeState?.status === "live"
                    ? "bg-success"
                    : realtimeState?.status === "delayed" ||
                        realtimeState?.status === "stale"
                      ? "bg-warning"
                      : "bg-destructive",
                )}
              />
              {t(
                `data.chart.realtime.status.${realtimeState?.status ?? "connecting"}`,
              )}
            </span>
          ) : null}
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
        <span className={cn(changeClass)}>
          {t("data.chart.legend.change")}{" "}
          {changePercent === null ? "-" : `${changePercent.toFixed(2)}%`}
        </span>
        <ChartValue
          label={
            volumeUnit
              ? t("data.chart.legend.volumeWithUnit", { unit: volumeUnit })
              : t("data.chart.legend.volume")
          }
          value={displayBar?.volume}
          formatter={compactNumber}
        />
        <ChartValue
          label={t("data.chart.legend.amount")}
          value={displayBar?.amount}
          formatter={compactNumber}
        />
      </div>

      {onStudiesChange ? (
        <StudyLegend
          instances={studies}
          values={displayedStudyValues}
          loading={studyLoading}
          error={studyError}
          onToggle={toggleStudy}
          onEdit={editStudy}
          onRemove={removeStudy}
          onMove={moveStudy}
        />
      ) : null}

      {onComparisonsChange ? (
        <ComparisonLegend
          mainSymbol={symbol}
          mainName={metadata?.name ?? null}
          comparisons={comparisonStates}
          values={displayedComparisonValues}
          onManage={() => setComparisonDialogOpen(true)}
          onRemove={(vtSymbol) =>
            onComparisonsChange(
              comparisons.filter((item) => item.vtSymbol !== vtSymbol),
            )
          }
          onRetry={(vtSymbol) => onRetryComparison?.(vtSymbol)}
        />
      ) : null}

      <div className="relative min-h-0 flex-1">
        <FinancialChart
          ref={chartRef}
          bars={bars}
          dataKey={dataKey}
          mainVtSymbol={symbol}
          chartType={options.chartType}
          metadata={metadata}
          priceReference={priceReference}
          previousCloseLabel={t("data.chart.previousClose")}
          locale={i18n.language}
          showVolume={options.showVolume}
          paneRatios={options.paneRatios}
          studies={studies}
          studyResults={studyResults}
          comparisonSeries={comparisonSeries}
          syncRuntime={syncRuntime}
          realtimeRuntime={realtimeRuntime}
          visible={visible}
          hasMoreBefore={hasMoreBefore}
          loadingMore={loadingMore}
          ariaLabel={t("data.chart.aria", {
            symbol: symbol ?? t("data.chart.title"),
          })}
          onCrosshairChange={handleCrosshairChange}
          onRequestMore={onRequestMore}
          onLatestBarChange={(bar) => setLiveBar({ dataKey, bar })}
          onFollowingLatestChange={(value) =>
            setFollowingLatest({ dataKey, value })
          }
          onPaneRatiosChange={
            density === "panel"
              ? (paneRatios) => onOptionsChange({ ...options, paneRatios })
              : undefined
          }
        />
        <ChartAccessibilityLayer
          summary={accessibilitySummary}
          rows={bars}
          formatTime={formatTime}
          formatPrice={formatPrice}
          formatVolume={formatVolume}
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
            className="absolute bottom-2 left-2 bg-background/90"
            onClick={onRequestMore}
          >
            {t("data.chart.historyRetry")}
          </Button>
        ) : null}
        {realtimeEnabled &&
        followingLatest?.dataKey === dataKey &&
        !followingLatest.value ? (
          <Button
            size="sm"
            variant="outline"
            className="absolute bottom-2 right-2 bg-background/90"
            onClick={() => chartRef.current?.returnToLatest()}
          >
            {t("data.chart.realtime.returnToLatest")}
          </Button>
        ) : null}
      </div>
      {indicatorDialogOpen && onStudiesChange ? (
        <Suspense fallback={null}>
          <IndicatorDialog
            open={indicatorDialogOpen}
            editingInstanceId={editingStudyId}
            instances={studies}
            onOpenChange={(open) => {
              setIndicatorDialogOpen(open);
              if (!open) setEditingStudyId(null);
            }}
            onChange={onStudiesChange}
          />
        </Suspense>
      ) : null}
      {comparisonDialogOpen && onComparisonsChange ? (
        <Suspense fallback={null}>
          <ComparisonDialog
            open={comparisonDialogOpen}
            mainSymbol={symbol}
            interval={options.interval}
            comparisons={comparisons}
            onOpenChange={setComparisonDialogOpen}
            onChange={onComparisonsChange}
          />
        </Suspense>
      ) : null}
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
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t("data.chart.retry")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
