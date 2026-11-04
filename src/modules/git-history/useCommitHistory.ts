/** 提交历史共用分页状态；查询变化隔离旧结果，同查询刷新保留内容，隐藏时停止追加。 */

import {
  createSnapshotCache,
  readViewResource,
  useViewActive,
} from "@/modules/view-state";
import { currentWorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";
import { useCallback, useEffect, useRef, useState } from "react";

type LoadStatus = "idle" | "initial" | "more" | "initial-error" | "more-error";
type PageOptions = { limit: number; skip?: number };
type HistoryState<T> = {
  key: string | null;
  commits: T[];
  loadStatus: LoadStatus;
  error: string | null;
  endReached: boolean;
  loaded: boolean;
  refreshKey?: string;
};
const historyCache = createSnapshotCache<HistoryState<{ sha: string }>>(32);

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
  enabled: requestedEnabled,
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
  const enabled = useViewActive(requestedEnabled);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const resourceKey = `${workspaceScopeKey(currentWorkspaceEnv())}\0${queryKey}`;
  const readState = (): HistoryState<T> =>
    (queryKey
      ? (historyCache.get(resourceKey) as HistoryState<T> | undefined)
      : undefined) ?? {
      key: queryKey,
      commits: [],
      loadStatus: "idle",
      error: null,
      endReached: false,
      loaded: false,
    };
  const [state, setState] = useState<HistoryState<T>>(readState);
  if (state.key !== queryKey) setState(readState());
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestRef = useRef(0);
  const queryRef = useRef(queryKey);
  queryRef.current = queryKey;
  const loadingRef = useRef(false);
  const [settled, setSettled] = useState(0);
  const loadedKeyRef = useRef<string | null>(
    state.loaded && state.refreshKey === refreshKey ? queryKey : null,
  );
  const current = state.key === queryKey;
  const commits = current ? state.commits : [];
  const loadStatus = current
    ? state.loadStatus === "idle" && !state.loaded && enabled && queryKey
      ? "initial"
      : state.loadStatus
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
    loadedKeyRef.current =
      stateRef.current.loaded &&
      stateRef.current.key === queryKey &&
      stateRef.current.refreshKey === refreshKey
        ? queryKey
        : null;
    return () => {
      requestRef.current += 1;
    };
  }, [queryKey, refreshKey]);

  const loadInitial = useCallback(async () => {
    if (!enabledRef.current || !queryKey || loadingRef.current) return;
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
        if (!enabledRef.current) return;
        const options = {
          limit,
          ...(next.length ? { skip: next.length } : {}),
        };
        const page = await readViewResource(
          `history:${resourceKey}:${refreshKey}:${JSON.stringify(options)}`,
          () => fetchPage(options),
        );
        if (request !== requestRef.current || queryRef.current !== queryKey)
          return;
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
      if (request !== requestRef.current || queryRef.current !== queryKey)
        return;
      loadedKeyRef.current = queryKey;
      const nextState: HistoryState<T> = {
        key: queryKey,
        commits: next,
        loadStatus: "idle",
        error: null,
        endReached,
        loaded: true,
        refreshKey,
      };
      historyCache.set(resourceKey, nextState);
      setState(nextState);
      onInitialLoaded?.(next);
    } catch (error) {
      if (request !== requestRef.current || queryRef.current !== queryKey)
        return;
      setState((previous) => ({
        ...previous,
        loadStatus: "initial-error",
        error: normalizeGitHistoryError(error),
      }));
    } finally {
      loadingRef.current = false;
      if (request === requestRef.current) {
        setState((current) =>
          current.loadStatus === "initial" || current.loadStatus === "more"
            ? { ...current, loadStatus: "idle" }
            : current,
        );
      } else setSettled((value) => value + 1);
    }
  }, [queryKey, resourceKey, refreshKey, fetchPage, onInitialLoaded]);

  useEffect(() => {
    void refreshKey;
    void settled;
    if (
      enabled &&
      queryKey &&
      loadedKeyRef.current !== queryKey &&
      !loadingRef.current
    )
      void loadInitial();
  }, [enabled, queryKey, refreshKey, loadInitial, settled]);

  const loadMore = useCallback(async () => {
    if (
      !enabledRef.current ||
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
      const options = { limit: morePageSize, skip: commits.length };
      const next = await readViewResource(
        `history:${resourceKey}:${refreshKey}:${JSON.stringify(options)}`,
        () => fetchPage(options),
      );
      if (request !== requestRef.current || queryRef.current !== queryKey)
        return;
      setState((previous) => {
        const known = new Set(previous.commits.map((commit) => commit.sha));
        const nextState = {
          ...previous,
          commits: previous.commits.concat(
            next.filter((commit) => !known.has(commit.sha)),
          ),
          loadStatus: "idle" as const,
          endReached: next.length < morePageSize,
        };
        historyCache.set(resourceKey, nextState);
        return nextState;
      });
    } catch (error) {
      if (request !== requestRef.current || queryRef.current !== queryKey)
        return;
      setState((previous) => ({
        ...previous,
        loadStatus: "more-error",
        error: normalizeGitHistoryError(error),
      }));
    } finally {
      loadingRef.current = false;
      if (request === requestRef.current) {
        setState((current) =>
          current.loadStatus === "initial" || current.loadStatus === "more"
            ? { ...current, loadStatus: "idle" }
            : current,
        );
      } else setSettled((value) => value + 1);
    }
  }, [
    queryKey,
    resourceKey,
    refreshKey,
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
