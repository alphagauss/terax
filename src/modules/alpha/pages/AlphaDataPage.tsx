/**
 * 本文件实现 Alpha 数据目录页面。
 * 页面按需查询证券目录、订阅同步任务进度并展示单证券 K 线，不在浏览器中执行全量搜索或质量计算。
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/controls/button";
import { Input } from "@/components/controls/input";
import {
  getAlphaDataOverview,
  getAlphaSecurities,
  getAlphaSyncOverview,
  startAlphaBarSync,
  type AlphaSecurity,
  type AlphaSyncOverview,
} from "@/modules/alpha/api";
import { MarketChartScene } from "@/modules/alpha/chart/scenes/MarketChartScene";
import {
  DEFAULT_MARKET_CHART_OPTIONS,
  type MarketChartOptions,
} from "@/modules/alpha/chart/model";
import {
  AlphaEmptyText,
  AlphaLoading,
  AlphaMetric,
  AlphaSectionTitle,
} from "@/modules/alpha/components/AlphaPagePrimitives";
import { AlphaSecurityTable } from "@/modules/alpha/components/AlphaSecurityTable";
import { AlphaServiceBoundary } from "@/modules/alpha/components/AlphaServiceBoundary";
import {
  subscribeAlphaEventConnection,
  subscribeAlphaTasks,
  taskDisplayStatus,
} from "@/modules/alpha/events/tasks";
import { alphaQueryKeys, AlphaQueryProvider } from "@/modules/alpha/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

const PAGE_SIZE = 50;
const ALL_FACET_VALUES = "__all__";

type Props = {
  visible: boolean;
};

/** 为数据目录页接入 Alpha 共享查询缓存。 */
export function AlphaDataPage(props: Props) {
  return (
    <AlphaQueryProvider>
      <AlphaServiceBoundary visible={props.visible}>
        <AlphaDataPageContent {...props} />
      </AlphaServiceBoundary>
    </AlphaQueryProvider>
  );
}

/** 连接数据目录、日线同步质量、Facets、分页和按需行情查询。 */
function AlphaDataPageContent({ visible }: Props) {
  const { t, i18n } = useTranslation("alpha");
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [exchange, setExchange] = useState("");
  const [assetType, setAssetType] = useState("");
  const [dataState, setDataState] = useState<"" | AlphaSecurity["data_state"]>(
    "",
  );
  const [interval, setInterval] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [chartOptions, setChartOptions] = useState<MarketChartOptions>(() => ({
    ...DEFAULT_MARKET_CHART_OPTIONS,
    paneRatios: { ...DEFAULT_MARKET_CHART_OPTIONS.paneRatios },
  }));
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [syncActionPending, setSyncActionPending] = useState(false);
  const [syncActionError, setSyncActionError] = useState<unknown>(null);
  const changeChartOptions = useCallback((next: MarketChartOptions) => {
    setChartOptions((current) => ({
      ...current,
      chartType: next.chartType,
    }));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setKeyword(searchInput.trim());
      setOffset(0);
      setSelectedSymbol(null);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const securityQuery = useMemo(
    () => ({
      q: keyword || undefined,
      exchange: exchange || undefined,
      assetType: assetType || undefined,
      dataState: dataState || undefined,
      interval: interval || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    [assetType, dataState, exchange, interval, keyword, offset],
  );
  const overview = useQuery({
    queryKey: alphaQueryKeys.dataOverview,
    queryFn: () => getAlphaDataOverview(),
    enabled: visible,
    staleTime: 30_000,
  });
  const securities = useQuery({
    queryKey: [...alphaQueryKeys.securities, securityQuery],
    queryFn: () => getAlphaSecurities(securityQuery),
    enabled: visible,
  });
  const syncOverview = useQuery({
    queryKey: alphaQueryKeys.syncOverview,
    queryFn: getAlphaSyncOverview,
    enabled: visible,
    staleTime: 0,
  });
  useEffect(() => {
    if (!visible) return;
    const releaseTasks = subscribeAlphaTasks((task) => {
      if (!task.kind.startsWith("sync")) return;
      queryClient.setQueryData<AlphaSyncOverview>(
        alphaQueryKeys.syncOverview,
        (current) => {
          if (!current) return current;
          const summary = {
            task_id: task.id,
            status: taskDisplayStatus(task.status),
            stage: task.stage,
            progress: task.progress,
            metrics: task.metrics,
            revision: task.revision,
            created_at: task.created_at,
            finished_at: task.finished_at,
            message: task.message,
          };
          const exists = current.tasks.some((item) => item.task_id === task.id);
          return {
            ...current,
            tasks: exists
              ? current.tasks.map((item) =>
                  item.task_id === task.id && item.revision <= task.revision
                    ? summary
                    : item,
                )
              : [summary, ...current.tasks],
          };
        },
      );
      if (task.status !== "running") {
        void Promise.all([
          queryClient.invalidateQueries({
            queryKey: alphaQueryKeys.syncOverview,
          }),
          queryClient.invalidateQueries({
            queryKey: alphaQueryKeys.dataOverview,
          }),
          queryClient.invalidateQueries({
            queryKey: alphaQueryKeys.securities,
          }),
          queryClient.invalidateQueries({ queryKey: alphaQueryKeys.bars }),
        ]);
      }
    });
    const releaseConnection = subscribeAlphaEventConnection((connected) => {
      if (connected) {
        void queryClient.invalidateQueries({
          queryKey: alphaQueryKeys.syncOverview,
        });
      }
    });
    return () => {
      releaseTasks();
      releaseConnection();
    };
  }, [queryClient, visible]);
  useEffect(() => {
    if (
      selectedSymbol &&
      securities.data &&
      !securities.data.items.some((item) => item.vt_symbol === selectedSymbol)
    ) {
      setSelectedSymbol(null);
    }
  }, [securities.data, selectedSymbol]);

  const number = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language],
  );
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(
    1,
    Math.ceil((securities.data?.total ?? 0) / PAGE_SIZE),
  );
  const updateFilter = useCallback(
    (setter: (value: string) => void, value: string) => {
      setter(value);
      setOffset(0);
      setSelectedSymbol(null);
    },
    [],
  );
  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const freshOverview = await getAlphaDataOverview(true);
      queryClient.setQueryData(alphaQueryKeys.dataOverview, freshOverview);
      await Promise.all([
        securities.refetch(),
        queryClient.invalidateQueries({ queryKey: alphaQueryKeys.bars }),
      ]);
    } catch (error) {
      setRefreshError(error);
    } finally {
      setRefreshing(false);
    }
  };
  const error = refreshError ?? overview.error ?? securities.error;
  const syncError = syncActionError ?? syncOverview.error;
  const summary = overview.data?.summary;
  const latestQuality = syncOverview.data?.latest;
  const activeSyncTask = syncOverview.data?.tasks.find(
    (task) => task.status === "running",
  );
  const syncRunning = Boolean(
    syncOverview.data?.tasks.some((task) => task.status === "running"),
  );
  const qualityStatus = syncRunning
    ? "running"
    : (latestQuality?.status ?? "idle");
  const qualityMessage = latestQuality?.message;
  const syncStatusText = activeSyncTask
    ? [
        t("data.sync.statuses.running"),
        activeSyncTask.stage
          ? t(`taskStages.${activeSyncTask.stage}`, {
              defaultValue: activeSyncTask.stage,
            })
          : null,
        activeSyncTask.progress?.completed != null &&
        activeSyncTask.progress.total != null
          ? `${activeSyncTask.progress.completed}/${activeSyncTask.progress.total}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : t(`data.sync.statuses.${qualityStatus}`);

  const startSync = async (vtSymbols?: readonly string[]) => {
    setSyncActionPending(true);
    setSyncActionError(null);
    try {
      await startAlphaBarSync(vtSymbols);
      await syncOverview.refetch();
    } catch (error) {
      setSyncActionError(error);
    } finally {
      setSyncActionPending(false);
    }
  };

  return (
    <div className="app-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-section p-4 sm:p-page">
        <PageHeader
          title={t("data.title")}
          description={t("data.description")}
          actions={
            <Button
              variant="outline"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              {t("common.refresh")}
            </Button>
          }
        />

        {error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {String(error)}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <AlphaMetric
            label={t("data.metrics.securities")}
            value={number.format(summary?.security_count ?? 0)}
          />
          <AlphaMetric
            label={t("data.metrics.profiles")}
            value={number.format(summary?.profile_count ?? 0)}
          />
          <AlphaMetric
            label={t("data.metrics.rows")}
            value={number.format(summary?.total_bar_count ?? 0)}
          />
          <AlphaMetric
            label={t("data.metrics.latest")}
            value={summary?.data_end?.slice(0, 10) ?? t("common.unavailable")}
          />
        </div>

        <section className="rounded-lg border border-border/60 bg-card p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <AlphaSectionTitle
              title={t("data.sync.title")}
              description={t("data.sync.description")}
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={syncRunning || syncActionPending}
                onClick={() => void startSync()}
              >
                {t("data.sync.start")}
              </Button>
              <Button
                variant="outline"
                disabled={
                  syncRunning ||
                  syncActionPending ||
                  !latestQuality?.failed_vt_symbols.length
                }
                onClick={() => void startSync(latestQuality?.failed_vt_symbols)}
              >
                {t("data.sync.retryFailed")}
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <AlphaMetric label={t("data.sync.status")} value={syncStatusText} />
            <AlphaMetric
              label={t("data.sync.savedRows")}
              value={number.format(
                Number(
                  activeSyncTask?.metrics.saved_rows ??
                    latestQuality?.saved_rows ??
                    0,
                ),
              )}
            />
            <AlphaMetric
              label={t("data.sync.issues")}
              value={number.format(latestQuality?.validation_issue_count ?? 0)}
            />
            <AlphaMetric
              label={t("data.sync.failedSymbols")}
              value={number.format(latestQuality?.failed_vt_symbol_count ?? 0)}
            />
          </div>
          {latestQuality?.failed_vt_symbols.length ? (
            <p className="mt-3 break-all text-xs text-muted-foreground">
              {t("data.sync.failedPreview", {
                symbols: latestQuality.failed_vt_symbols.slice(0, 5).join(", "),
              })}
            </p>
          ) : null}
          {qualityMessage ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {t("data.sync.message", { message: qualityMessage })}
            </p>
          ) : null}
          {syncError ? (
            <p className="mt-3 text-xs text-destructive">
              {t("data.sync.actionFailed", { error: String(syncError) })}
            </p>
          ) : null}
        </section>

        <section className="min-w-0 rounded-lg border border-border/60 bg-card p-3">
          <AlphaSectionTitle
            title={t("data.securities.title")}
            description={t("data.securities.description", {
              count: securities.data?.total ?? 0,
            })}
          />
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
            <Input
              value={searchInput}
              placeholder={t("data.search.placeholder")}
              aria-label={t("data.search.label")}
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <FacetSelect
              label={t("data.filters.exchange")}
              value={exchange}
              options={overview.data?.facets.exchanges ?? []}
              onChange={(value) => updateFilter(setExchange, value)}
            />
            <FacetSelect
              label={t("data.filters.assetType")}
              value={assetType}
              options={overview.data?.facets.asset_types ?? []}
              onChange={(value) => updateFilter(setAssetType, value)}
            />
            <FacetSelect
              label={t("data.filters.dataState")}
              value={dataState}
              options={(overview.data?.facets.data_states ?? []).map(
                (option) => ({
                  ...option,
                  label: t(`data.states.${option.value}`),
                }),
              )}
              onChange={(value) =>
                updateFilter(
                  (next) =>
                    setDataState(next as "" | AlphaSecurity["data_state"]),
                  value,
                )
              }
            />
            <FacetSelect
              label={t("data.filters.interval")}
              value={interval}
              options={(overview.data?.facets.intervals ?? []).map(
                (option) => ({
                  value: option.value,
                  count: option.security_count,
                }),
              )}
              onChange={(value) => updateFilter(setInterval, value)}
            />
          </div>

          <div className="mt-3">
            {securities.isPending ? (
              <div className="h-64">
                <AlphaLoading label={t("common.loading")} />
              </div>
            ) : securities.data?.items.length ? (
              <AlphaSecurityTable
                rows={securities.data.items}
                selectedSymbol={selectedSymbol}
                onSelect={setSelectedSymbol}
              />
            ) : (
              <div className="h-64">
                <AlphaEmptyText>{t("data.securities.empty")}</AlphaEmptyText>
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{t("data.pagination.page", { page, pageCount })}</span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={offset === 0 || securities.isFetching}
                onClick={() => {
                  setSelectedSymbol(null);
                  setOffset((current) => Math.max(0, current - PAGE_SIZE));
                }}
              >
                {t("data.pagination.previous")}
              </Button>
              <Button
                variant="outline"
                disabled={page >= pageCount || securities.isFetching}
                onClick={() => {
                  setSelectedSymbol(null);
                  setOffset((current) => current + PAGE_SIZE);
                }}
              >
                {t("data.pagination.next")}
              </Button>
            </div>
          </div>
        </section>

        <section className="min-w-0 rounded-lg border border-border/60 bg-card p-3">
          <AlphaSectionTitle
            title={selectedSymbol ?? t("data.chart.title")}
            description={t("data.chart.description")}
          />
          <div className="mt-3 h-96">
            <MarketChartScene
              vtSymbol={selectedSymbol}
              visible={visible}
              options={chartOptions}
              density="compact"
              onOptionsChange={changeChartOptions}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

type FacetOption = {
  value: string;
  count: number;
  label?: string;
};

/** 渲染带全局数量且复用项目统一样式与动效的 Facet 选择器。 */
function FacetSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: FacetOption[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value || ALL_FACET_VALUES}
      onValueChange={(nextValue) =>
        onChange(nextValue === ALL_FACET_VALUES ? "" : nextValue)
      }
    >
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent align="start" position="popper">
        <SelectItem value={ALL_FACET_VALUES}>{label}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label ?? option.value} ({option.count})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
