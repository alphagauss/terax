/**
 * 本文件提供 Alpha 页面共享的内存查询缓存和服务状态查询。
 * 查询结果不持久化，服务运行状态始终以 Rust 受认证探活结果为准。
 */

import { getAlphaStatus } from "@/modules/alpha/native";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";

export const alphaQueryKeys = {
  all: ["alpha"] as const,
  service: ["alpha", "service"] as const,
  settings: ["alpha", "settings"] as const,
  overview: ["alpha", "overview"] as const,
  dataOverview: ["alpha", "data-overview"] as const,
  syncOverview: ["alpha", "sync-overview"] as const,
  securities: ["alpha", "securities"] as const,
  security: (vtSymbol: string) => ["alpha", "security", vtSymbol] as const,
  securitySnapshot: (symbol: string) =>
    ["alpha", "security-snapshot", symbol] as const,
  bars: ["alpha", "bars"] as const,
  comparisonBars: (
    vtSymbol: string,
    interval: string,
    adjust: string,
    start: string | null,
    end: string | null,
    limit: number,
  ) =>
    [
      "alpha",
      "bars",
      "comparison",
      vtSymbol,
      interval,
      adjust,
      start,
      end,
      limit,
    ] as const,
  studyDefinitions: ["alpha", "study-definitions"] as const,
  studyCalculation: (
    dataKey: string,
    actualStart: string | null,
    actualEnd: string | null,
    calculationSignature: string,
  ) =>
    [
      "alpha",
      "study-calculation",
      dataKey,
      actualStart,
      actualEnd,
      calculationSignature,
    ] as const,
};

const alphaQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 5 * 60_000,
      retry: 1,
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
  },
});

/** 为单个 Alpha 页面接入共享但不落盘的查询缓存。 */
export function AlphaQueryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <QueryClientProvider client={alphaQueryClient}>
      {children}
    </QueryClientProvider>
  );
}

/** 清空当前进程内的 Alpha 查询结果和观察任务，供隔离测试使用。 */
export function clearAlphaQueryCache(): void {
  alphaQueryClient.clear();
}

/**
 * 订阅共享 Alpha 服务的实时状态。
 *
 * 仅可见页面参与探活和轮询；所有调用方通过同一查询缓存共享结果。
 */
export function useAlphaServiceStatus(visible: boolean) {
  return useQuery({
    queryKey: alphaQueryKeys.service,
    queryFn: getAlphaStatus,
    enabled: visible,
    refetchInterval: visible ? 2_500 : false,
    retry: false,
    staleTime: 0,
  });
}
