/**
 * 本文件把 Alpha 有界历史查询连接到公共金融图表。
 * Scene 负责权威周期、排他游标、跨页合并和查询键隔离，不接触图表实例。
 */

import { getAlphaBars, getAlphaSecurity } from "@/modules/alpha/api";
import { FinancialChartFrame } from "@/modules/alpha/chart/components/FinancialChartFrame";
import type {
  FinancialChartStatus,
  MarketChartDensity,
  MarketChartInterval,
  MarketChartOptions,
} from "@/modules/alpha/chart/model";
import { MARKET_CHART_INTERVALS } from "@/modules/alpha/chart/model";
import type { MarketBar, MarketBarPage } from "@/modules/alpha/market/model";
import { mergeMarketBarPages } from "@/modules/alpha/market/normalize";
import { alphaQueryKeys } from "@/modules/alpha/query";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

type Props = {
  vtSymbol: string | null;
  visible: boolean;
  options: MarketChartOptions;
  density: MarketChartDensity;
  onOptionsChange: (options: MarketChartOptions) => void;
};

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

/** 为单证券和受控配置提供权威周期、有界历史分页及公共图表状态。 */
export function MarketChartScene({
  vtSymbol,
  visible,
  options,
  density,
  onOptionsChange,
}: Props) {
  const securityQuery = useQuery({
    queryKey: alphaQueryKeys.security(vtSymbol ?? ""),
    queryFn: () => getAlphaSecurity(vtSymbol ?? ""),
    enabled: density === "panel" && visible && vtSymbol !== null,
  });
  const declaredIntervals = useMemo(
    () => supportedChartIntervals(securityQuery.data?.intervals ?? []),
    [securityQuery.data?.intervals],
  );
  const availableIntervals =
    declaredIntervals.length > 0 ? declaredIntervals : [options.interval];

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
      dataKey={
        vtSymbol ? `${vtSymbol}|${options.interval}|${options.adjust}` : "empty"
      }
      symbol={vtSymbol}
      options={options}
      availableIntervals={availableIntervals}
      density={density}
      status={status}
      historyError={query.isFetchNextPageError}
      hasMoreBefore={Boolean(query.hasNextPage)}
      loadingMore={query.isFetchingNextPage}
      visible={visible}
      onOptionsChange={onOptionsChange}
      onRequestMore={requestMore}
      onRetry={retry}
    />
  );
}
