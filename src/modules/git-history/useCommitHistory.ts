/** 提交历史共用分页状态；查询变化隔离旧结果，同查询刷新保留内容，隐藏时停止追加。 */

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
  refreshKey,
  enabled,
  fetchPage,
  morePageSize = 40,
  onInitialLoaded,
}: {
  queryKey: string | null;
  /** 查询身份不变时重新读取历史，保留已有结果直到刷新成功。 */
  refreshKey?: string;
  enabled: boolean;
  fetchPage: (options: PageOptions) => Promise<T[]>;
  morePageSize?: number;
  onInitialLoaded?: (commits: T[]) => void;
}) {
  const [state, setState] = useState<{
    key: string | null;
    commits: T[];
    loadStatus: LoadStatus;
    error: string | null;
    endReached: boolean;
    loaded: boolean;
  }>({
    key: null,
    commits: [],
    loadStatus: "idle",
    error: null,
    endReached: false,
    loaded: false,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const loadedKeyRef = useRef<string | null>(null);
  const current = state.key === queryKey;
  const commits = current ? state.commits : [];
  const loadStatus = current
    ? state.loadStatus
    : enabled && queryKey
      ? "initial"
      : "idle";
  const error = current ? state.error : null;
  const endReached = current && state.endReached;
  const refreshing = current && state.loaded && loadStatus === "initial";

  useEffect(() => {
    void queryKey;
    void refreshKey;
    requestRef.current += 1;
    loadingRef.current = false;
    loadedKeyRef.current = null;
    return () => {
      requestRef.current += 1;
    };
  }, [queryKey, refreshKey]);

  const loadInitial = useCallback(async () => {
    if (!enabled || !queryKey) return;
    const request = ++requestRef.current;
    const previous = stateRef.current;
    const refreshing = previous.key === queryKey && previous.loaded;
    loadingRef.current = true;
    setState((previous) => ({
      key: queryKey,
      commits: previous.key === queryKey ? previous.commits : [],
      loadStatus: "initial",
      error: null,
      endReached: previous.key === queryKey && previous.endReached,
      loaded: refreshing,
    }));
    try {
      // 按新旧提交的相对位置补齐历史，避免固定多读一页仍挤掉原来的阅读范围。
      let target = refreshing ? Math.max(40, previous.commits.length) : 40;
      const positions = new Map(
        previous.commits.map((commit, index) => [commit.sha, index]),
      );
      const next: T[] = [];
      let endReached = false;
      while (next.length < target) {
        const limit = Math.min(200, target - next.length);
        const page = await fetchPage({
          limit,
          ...(next.length ? { skip: next.length } : {}),
        });
        if (request !== requestRef.current) return;
        if (refreshing)
          page.forEach((commit, index) => {
            const oldIndex = positions.get(commit.sha);
            if (oldIndex !== undefined)
              target = Math.max(
                target,
                previous.commits.length + next.length + index - oldIndex,
              );
          });
        next.push(...page);
        endReached = page.length < limit;
        if (endReached) break;
      }
      if (request !== requestRef.current) return;
      loadedKeyRef.current = queryKey;
      setState({
        key: queryKey,
        commits: next,
        loadStatus: "idle",
        error: null,
        endReached,
        loaded: true,
      });
      onInitialLoaded?.(next);
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
    void refreshKey;
    if (
      enabled &&
      queryKey &&
      loadedKeyRef.current !== queryKey &&
      !loadingRef.current
    )
      void loadInitial();
  }, [enabled, queryKey, refreshKey, loadInitial]);

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

  return {
    commits,
    loadStatus,
    refreshing,
    error,
    endReached,
    loadInitial,
    loadMore,
  };
}
