/**
 * 本文件实现 Alpha 数据目录页面。
 * 页面按需查询 union 证券目录、全局 Facets 和单证券 K 线，不在浏览器中执行全量搜索。
 */

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getAlphaBars,
  getAlphaDataOverview,
  getAlphaSecurities,
  type AlphaSecurity,
} from "@/modules/alpha/api";
import { AlphaFinancialChart } from "@/modules/alpha/components/AlphaFinancialChart";
import {
  AlphaEmptyText,
  AlphaLoading,
  AlphaMetric,
  AlphaSectionTitle,
} from "@/modules/alpha/components/AlphaPagePrimitives";
import { AlphaSecurityTable } from "@/modules/alpha/components/AlphaSecurityTable";
import { AlphaServiceBoundary } from "@/modules/alpha/components/AlphaServiceBoundary";
import { alphaQueryKeys, AlphaQueryProvider } from "@/modules/alpha/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

const PAGE_SIZE = 50;

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

/** 连接数据目录、Facets、分页和按需行情查询。 */
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
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);

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
  const bars = useQuery({
    queryKey: ["alpha", "bars", selectedSymbol, "d", "forward"],
    queryFn: () => getAlphaBars(selectedSymbol ?? ""),
    enabled: visible && selectedSymbol !== null,
  });

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
        selectedSymbol ? bars.refetch() : Promise.resolve(),
      ]);
    } catch (error) {
      setRefreshError(error);
    } finally {
      setRefreshing(false);
    }
  };
  const error = refreshError ?? overview.error ?? securities.error;
  const summary = overview.data?.summary;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-5">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold">{t("data.title")}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("data.description")}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {t("common.refresh")}
          </Button>
        </header>

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

        <section className="min-w-0 rounded-xl border border-border/70 bg-card p-4">
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
                size="sm"
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
                size="sm"
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

        <section className="min-w-0 rounded-xl border border-border/70 bg-card p-4">
          <AlphaSectionTitle
            title={selectedSymbol ?? t("data.chart.title")}
            description={t("data.chart.description")}
          />
          <div className="mt-3 h-96">
            {bars.isPending && selectedSymbol ? (
              <AlphaLoading label={t("common.loading")} />
            ) : bars.error ? (
              <AlphaEmptyText>{String(bars.error)}</AlphaEmptyText>
            ) : bars.data?.items.length ? (
              <AlphaFinancialChart
                bars={bars.data.items}
                visible={visible}
                ariaLabel={t("data.chart.aria", { symbol: selectedSymbol })}
              />
            ) : (
              <AlphaEmptyText>{t("data.chart.empty")}</AlphaEmptyText>
            )}
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

/** 渲染带全局数量的轻量 Facet 选择器。 */
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
    <select
      aria-label={label}
      value={value}
      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label ?? option.value} ({option.count})
        </option>
      ))}
    </select>
  );
}
