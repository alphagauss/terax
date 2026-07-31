/**
 * 本文件提供 Alpha 页面共享的内存查询缓存。
 * 查询结果不持久化，页面恢复后仍以 FastAPI 的 HTTP 状态为准。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
