/**
 * 本文件把 Alpha 有界历史查询连接到公共金融图表。
 * Scene 负责权威证券元数据、参考价、排他游标、跨页合并、按需指标与对比查询及可选同步桥转发。
 */

import {
  calculateAlphaStudies,
  getAlphaBars,
  getAlphaSecurity,
} from "@/modules/alpha/api";
import { normalizeChartComparisons } from "@/modules/alpha/chart/comparison/normalize";
import { FinancialChartFrame } from "@/modules/alpha/chart/components/FinancialChartFrame";
import type {
  ChartComparisonConfig,
  ChartComparisonState,
  FinancialChartStatus,
  MarketChartDensity,
  MarketChartInterval,
  MarketChartOptions,
} from "@/modules/alpha/chart/model";
import { MARKET_CHART_INTERVALS } from "@/modules/alpha/chart/model";
import {
  type ChartStudyInstance,
  normalizeVisibleStudyInstances,
  studyCalculationSignature,
} from "@/modules/alpha/chart/studies/model";
import type { FinancialChartSyncRuntime } from "@/modules/alpha/chart/sync/ChartSyncContext";
import { createChartMarketMetadata } from "@/modules/alpha/market/metadata";
import type { MarketBar, MarketBarPage } from "@/modules/alpha/market/model";
import { mergeMarketBarPages } from "@/modules/alpha/market/normalize";
import { alphaQueryKeys } from "@/modules/alpha/query";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

type Props = {
  vtSymbol: string | null;
  visible: boolean;
  options: MarketChartOptions;
  density: MarketChartDensity;
  onOptionsChange: (options: MarketChartOptions) => void;
  studies?: readonly ChartStudyInstance[];
  onStudiesChange?: (studies: ChartStudyInstance[]) => void;
  comparisons?: readonly ChartComparisonConfig[];
  onComparisonsChange?: (comparisons: ChartComparisonConfig[]) => void;
  syncRuntime?: FinancialChartSyncRuntime | null;
};

const EMPTY_STUDIES: readonly ChartStudyInstance[] = [];
const EMPTY_COMPARISONS: readonly ChartComparisonConfig[] = [];
export const MAX_COMPARISON_BARS = 5_000;

/** 把按“最新到更早”存放的查询页合并成时间升序行情。 */
export function mergeHistoricalPages(
  pages: readonly MarketBarPage[],
): MarketBar[] {
  const chronological: MarketBar[] = [];
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    chronological.push(...pages[index].items);
  }
  return mergeMarketBarPages([], chronological);
}

/** 过滤证券详情声明的周期，K 线图不接受 tick 或未知值。 */
export function supportedChartIntervals(
  intervals: readonly string[],
): MarketChartInterval[] {
  const declared = new Set(intervals);
  return MARKET_CHART_INTERVALS.filter((interval) => declared.has(interval));
}

/**
 * 为单证券和受控配置提供权威周期、有界历史分页及按可见性启用的指标查询。
 */
export function MarketChartScene({
  vtSymbol,
  visible,
  options,
  density,
  onOptionsChange,
  studies = EMPTY_STUDIES,
  onStudiesChange,
  comparisons = EMPTY_COMPARISONS,
  onComparisonsChange,
  syncRuntime = null,
}: Props) {
  const securityQuery = useQuery({
    queryKey: alphaQueryKeys.security(vtSymbol ?? ""),
    queryFn: () => getAlphaSecurity(vtSymbol ?? ""),
    enabled: visible && vtSymbol !== null,
  });
  const declaredIntervals = useMemo(
    () => supportedChartIntervals(securityQuery.data?.intervals ?? []),
    [securityQuery.data?.intervals],
  );
  const availableIntervals =
    declaredIntervals.length > 0 ? declaredIntervals : [options.interval];
  const metadata = useMemo(
    () =>
      securityQuery.data
        ? createChartMarketMetadata(securityQuery.data, declaredIntervals)
        : null,
    [declaredIntervals, securityQuery.data],
  );

  const query = useInfiniteQuery({
    queryKey: [
      ...alphaQueryKeys.bars,
      vtSymbol,
      options.interval,
      options.adjust,
    ],
    queryFn: ({ pageParam }) =>
      getAlphaBars(vtSymbol ?? "", {
        interval: options.interval,
        adjust: options.adjust,
        before: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage, _pages, _lastPageParam, pageParams) => {
      const nextBefore = lastPage.hasMoreBefore ? lastPage.nextBefore : null;
      return nextBefore && !pageParams.includes(nextBefore)
        ? nextBefore
        : undefined;
    },
    enabled: visible && vtSymbol !== null,
  });
  const bars = useMemo(
    () => mergeHistoricalPages(query.data?.pages ?? []),
    [query.data?.pages],
  );
  const firstPage = query.data?.pages[0];
  const oldestPage = query.data?.pages[query.data.pages.length - 1];
  const actualStart = oldestPage?.actualStart ?? null;
  const actualEnd = firstPage?.actualEnd ?? null;
  const activeComparisons = useMemo(
    () => comparisons.filter((item) => item.vtSymbol !== vtSymbol),
    [comparisons, vtSymbol],
  );
  const comparisonLimit = Math.min(
    Math.max(bars.length, 1),
    MAX_COMPARISON_BARS,
  );
  const comparisonQueries = useQueries({
    queries: activeComparisons.map((comparison) => ({
      queryKey: alphaQueryKeys.comparisonBars(
        comparison.vtSymbol,
        options.interval,
        options.adjust,
        actualStart,
        actualEnd,
        comparisonLimit,
      ),
      queryFn: () =>
        getAlphaBars(comparison.vtSymbol, {
          interval: options.interval,
          adjust: options.adjust,
          start: actualStart ?? undefined,
          end: actualEnd ?? undefined,
          limit: comparisonLimit,
        }),
      enabled:
        visible &&
        actualStart !== null &&
        actualEnd !== null &&
        bars.length > 0,
    })),
  });
  const comparisonMetadataQueries = useQueries({
    queries: activeComparisons.map((comparison) => ({
      queryKey: alphaQueryKeys.security(comparison.vtSymbol),
      queryFn: () => getAlphaSecurity(comparison.vtSymbol),
      enabled: visible,
    })),
  });
  const comparisonPages = [
    comparisonQueries[0]?.data,
    comparisonQueries[1]?.data,
    comparisonQueries[2]?.data,
  ] as const;
  const comparisonNames = [
    comparisonMetadataQueries[0]?.data?.name,
    comparisonMetadataQueries[1]?.data?.name,
    comparisonMetadataQueries[2]?.data?.name,
  ] as const;
  const comparisonNormalization = useMemo(
    () =>
      normalizeChartComparisons(
        activeComparisons.length > 0 && vtSymbol
          ? [
              {
                vtSymbol,
                name: metadata?.name ?? vtSymbol,
                color: "#000000",
                bars,
              },
              ...activeComparisons.flatMap((comparison, index) => {
                const page = comparisonPages[index];
                if (!page) return [];
                return [
                  {
                    ...comparison,
                    name: comparisonNames[index] ?? comparison.vtSymbol,
                    bars: page.items,
                  },
                ];
              }),
            ]
          : [],
      ),
    [
      activeComparisons,
      bars,
      comparisonNames[0],
      comparisonNames[1],
      comparisonNames[2],
      comparisonPages[0],
      comparisonPages[1],
      comparisonPages[2],
      metadata?.name,
      vtSymbol,
    ],
  );
  const normalizedSeriesBySymbol = new Map(
    comparisonNormalization.series.map((item) => [item.vtSymbol, item]),
  );
  const normalizationErrors = new Map(
    comparisonNormalization.errors.map((error) => [error.vtSymbol, error.kind]),
  );
  const comparisonStates: ChartComparisonState[] = activeComparisons.map(
    (comparison, index) => {
      const result = comparisonQueries[index];
      const page = result?.data;
      const normalized = normalizedSeriesBySymbol.get(comparison.vtSymbol);
      const normalizationError = normalizationErrors.get(comparison.vtSymbol);
      const status = result?.isError
        ? "error"
        : !page
          ? "loading"
          : normalizationError === "zero-base"
            ? "zero-base"
            : normalizationError === "empty" || !normalized
              ? "empty"
              : "ready";
      return {
        vtSymbol: comparison.vtSymbol,
        name:
          comparisonMetadataQueries[index]?.data?.name ?? comparison.vtSymbol,
        color: comparison.color,
        points: normalized?.points ?? [],
        status,
        partial:
          status === "ready" &&
          (bars.length > MAX_COMPARISON_BARS ||
            (actualStart !== null && page?.actualStart !== actualStart)),
      };
    },
  );
  const retryComparison = useCallback(
    (vtSymbol: string) => {
      const index = activeComparisons.findIndex(
        (comparison) => comparison.vtSymbol === vtSymbol,
      );
      if (index >= 0) void comparisonQueries[index]?.refetch();
    },
    [activeComparisons, comparisonQueries],
  );
  const dataKey = vtSymbol
    ? `${vtSymbol}|${options.interval}|${options.adjust}`
    : "empty";
  const visibleStudies = useMemo(
    () => normalizeVisibleStudyInstances(studies),
    [studies],
  );
  const calculationSignature = useMemo(
    () => studyCalculationSignature(visibleStudies),
    [visibleStudies],
  );
  const studyQuery = useQuery({
    queryKey: alphaQueryKeys.studyCalculation(
      dataKey,
      actualStart,
      actualEnd,
      calculationSignature,
    ),
    queryFn: () =>
      calculateAlphaStudies({
        vtSymbol: vtSymbol ?? "",
        interval: options.interval,
        adjust: options.adjust,
        start: actualStart ?? "",
        end: actualEnd ?? "",
        studies: visibleStudies,
      }),
    enabled:
      visible &&
      vtSymbol !== null &&
      visibleStudies.length > 0 &&
      actualStart !== null &&
      actualEnd !== null,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === dataKey ? previous : undefined,
  });
  const priceReference = useMemo(
    () => ({
      previousClose: firstPage?.referenceClose ?? null,
      referenceTime: firstPage?.referenceTime ?? null,
    }),
    [firstPage],
  );
  const requestMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [query.fetchNextPage, query.hasNextPage, query.isFetchingNextPage]);
  const retry = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);

  let status: FinancialChartStatus = "idle";
  if (vtSymbol && query.isPending) status = "loading";
  else if (vtSymbol && query.error && bars.length === 0) status = "error";
  else if (vtSymbol && bars.length === 0) status = "empty";
  else if (vtSymbol) status = "ready";

  return (
    <FinancialChartFrame
      bars={bars}
      dataKey={dataKey}
      symbol={vtSymbol}
      options={options}
      metadata={metadata}
      priceReference={priceReference}
      availableIntervals={availableIntervals}
      density={density}
      status={status}
      historyError={query.isFetchNextPageError}
      hasMoreBefore={Boolean(query.hasNextPage)}
      loadingMore={query.isFetchingNextPage}
      visible={visible}
      studies={studies}
      studyResults={studyQuery.data?.items ?? []}
      studyLoading={studyQuery.isFetching && visibleStudies.length > 0}
      studyError={studyQuery.isError}
      comparisons={activeComparisons}
      comparisonStates={comparisonStates}
      comparisonSeries={comparisonNormalization.series}
      syncRuntime={syncRuntime}
      onOptionsChange={onOptionsChange}
      onStudiesChange={onStudiesChange}
      onComparisonsChange={onComparisonsChange}
      onRetryComparison={retryComparison}
      onRequestMore={requestMore}
      onRetry={retry}
    />
  );
}
