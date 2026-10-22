/** 提交历史共用分页状态；查询变化立即隔离旧结果，隐藏时保留缓存并停止追加。 */

import { useCallback, useEffect, useRef, useState } from "react";

type LoadStatus = "idle" | "initial" | "more" | "initial-error" | "more-error";
type PageOptions = { limit: number; skip?: number };

/** 保留原生错误消息，兼容 Error 与 IPC 返回的消息对象。 */
export function normalizeGitHistoryError(error: unknown): string {
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return "Unknown Git error";
}

/** Graph 与文件时间线共用加载、重试和过期请求保护，展示及搜索规则由调用方拥有。 */
export function useCommitHistory<T extends { sha: string }>({
  queryKey,
  enabled,
  fetchPage,
  morePageSize = 40,
  onInitialLoaded,
}: {
  queryKey: string | null;
  enabled: boolean;
  fetchPage: (options: PageOptions) => Promise<T[]>;
  morePageSize?: number;
  onInitialLoaded?: () => void;
}) {
  const [state, setState] = useState<{
    key: string | null;
    commits: T[];
    loadStatus: LoadStatus;
    error: string | null;
    endReached: boolean;
  }>({
    key: null,
    commits: [],
    loadStatus: "idle",
    error: null,
    endReached: false,
  });
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const loadedKeyRef = useRef<string | null>(null);
  const current = state.key === queryKey;
  const commits = current ? state.commits : [];
  const loadStatus = current ? state.loadStatus : "idle";
  const error = current ? state.error : null;
  const endReached = current && state.endReached;

  useEffect(() => {
    void queryKey;
    requestRef.current += 1;
    loadingRef.current = false;
    loadedKeyRef.current = null;
    return () => {
      requestRef.current += 1;
    };
  }, [queryKey]);

  const loadInitial = useCallback(async () => {
    if (!enabled || !queryKey) return;
    const request = ++requestRef.current;
    loadingRef.current = true;
    setState((previous) => ({
      key: queryKey,
      commits: previous.key === queryKey ? previous.commits : [],
      loadStatus: "initial",
      error: null,
      endReached: false,
    }));
    try {
      const next = await fetchPage({ limit: 40 });
      if (request !== requestRef.current) return;
      loadedKeyRef.current = queryKey;
      setState({
        key: queryKey,
        commits: next,
        loadStatus: "idle",
        error: null,
        endReached: next.length < 40,
      });
      onInitialLoaded?.();
    } catch (error) {
      if (request !== requestRef.current) return;
      setState((previous) => ({
        ...previous,
        loadStatus: "initial-error",
        error: normalizeGitHistoryError(error),
      }));
    } finally {
      if (request === requestRef.current) loadingRef.current = false;
    }
  }, [enabled, queryKey, fetchPage, onInitialLoaded]);

  useEffect(() => {
    if (
      enabled &&
      queryKey &&
      loadedKeyRef.current !== queryKey &&
      !loadingRef.current
    )
      void loadInitial();
  }, [enabled, queryKey, loadInitial]);

  const loadMore = useCallback(async () => {
    if (
      !enabled ||
      !queryKey ||
      endReached ||
      loadingRef.current ||
      commits.length === 0 ||
      (loadStatus !== "idle" && loadStatus !== "more-error")
    )
      return;
    const request = requestRef.current;
    loadingRef.current = true;
    setState((previous) => ({ ...previous, loadStatus: "more", error: null }));
    try {
      const next = await fetchPage({
        limit: morePageSize,
        skip: commits.length,
      });
      if (request !== requestRef.current) return;
      setState((previous) => {
        const known = new Set(previous.commits.map((commit) => commit.sha));
        return {
          ...previous,
          commits: previous.commits.concat(
            next.filter((commit) => !known.has(commit.sha)),
          ),
          loadStatus: "idle",
          endReached: next.length < morePageSize,
        };
      });
    } catch (error) {
      if (request !== requestRef.current) return;
      setState((previous) => ({
        ...previous,
        loadStatus: "more-error",
        error: normalizeGitHistoryError(error),
      }));
    } finally {
      if (request === requestRef.current) loadingRef.current = false;
    }
  }, [
    enabled,
    queryKey,
    endReached,
    commits,
    loadStatus,
    fetchPage,
    morePageSize,
  ]);

  return { commits, loadStatus, error, endReached, loadInitial, loadMore };
}
