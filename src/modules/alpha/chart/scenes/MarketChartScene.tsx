/**
 * 本文件把 Alpha 有界历史查询连接到公共金融图表。
 * Scene 负责排他游标、跨页合并、请求单飞和查询键隔离，不接触图表实例。
 */

import { getAlphaBars } from "@/modules/alpha/api";
import { FinancialChartFrame } from "@/modules/alpha/chart/components/FinancialChartFrame";
import type {
  FinancialChartStatus,
  FinancialChartType,
} from "@/modules/alpha/chart/model";
import type { MarketBar, MarketBarPage } from "@/modules/alpha/market/model";
import { mergeMarketBarPages } from "@/modules/alpha/market/normalize";
import { alphaQueryKeys } from "@/modules/alpha/query";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

type Props = {
  vtSymbol: string | null;
  visible: boolean;
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

/** 为单证券提供有界历史分页和公共图表状态。 */
export function MarketChartScene({ vtSymbol, visible }: Props) {
  const [chartType, setChartType] = useState<FinancialChartType>("candlestick");
  const query = useInfiniteQuery({
    queryKey: [...alphaQueryKeys.bars, vtSymbol, "d", "forward"],
    queryFn: ({ pageParam }) =>
      getAlphaBars(vtSymbol ?? "", {
        interval: "d",
        adjust: "forward",
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
      dataKey={vtSymbol ? `${vtSymbol}|d|forward` : "empty"}
      symbol={vtSymbol}
      chartType={chartType}
      status={status}
      historyError={query.isFetchNextPageError}
      hasMoreBefore={Boolean(query.hasNextPage)}
      loadingMore={query.isFetchingNextPage}
      visible={visible}
      onChartTypeChange={setChartType}
      onRequestMore={requestMore}
      onRetry={retry}
    />
  );
}
