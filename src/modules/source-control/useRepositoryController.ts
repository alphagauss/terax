/**
 * 本文件维护工作区当前 Git 仓库的唯一控制器。
 * 所有调用方共享真实快照与单调 revision；基础状态先发布，引用与可见统计共用串行刷新周期。
 */

import {
  createSnapshotCache,
  readViewResource,
  useViewActive,
} from "@/modules/view-state";
import { documentPathIdentity } from "@/lib/pathIdentity";
import {
  type GitPanelDiffStats,
  type GitRepoInfo,
  type GitStatusSnapshot,
  native,
} from "@/modules/ai/lib/native";
import {
  subscribeFileSystemChanges,
  subscribeWorkspaceResume,
} from "@/modules/filesystem";
import { subscribeTerminalCommandFinished } from "@/modules/terminal/lib/commandCompletion";
import { useRemoteRuntimeStore } from "@/modules/remote";
import {
  useWorkspaceEnvStore,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRepositoryRefreshQueue } from "./repositoryRefresh";
import { shareDiffStats, shareRepositorySnapshot } from "./repositorySharing";

// 相同上下文在短时间内复用快照；路径一旦变化就重新发现仓库，避免漏掉嵌套仓库。
const SC_STATUS_TTL_MS = 2000;
const FOREGROUND_REFRESH_MS = 3000;
const BACKGROUND_REFRESH_MS = 5000;
const isWindowVisible = () => document.visibilityState !== "hidden";

type RepositoryRemoteAction = "fetch" | "pull" | "push";
type RepositoryRemoteActionMode = "contextual" | RepositoryRemoteAction;

type RepositoryRemoteActionResult = {
  ok: boolean;
  action: RepositoryRemoteAction | null;
  error?: string;
  blocked?: "diverged" | "missing-upstream" | "no-repo";
};

/** 当前工作区仓库的唯一可观察快照与操作入口。 */
export type RepositoryController = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  changedCount: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRepo: boolean;
  /** 当前上下文尚未完成首次检测；已有结果的后台复查不进入加载态。 */
  isLoading: boolean;
  localError: string | null;
  busyAction: RepositoryRemoteAction | null;
  lastRemoteError: string | null;
  /** 每次成功读取真实仓库快照后递增，供可见派生视图重新加载。 */
  revision: number;
  /** Git 引用摘要；首次引用校验完成前为空，避免加载存在竞态的提交图。 */
  graphRevision: string | null;
  diffStats: GitPanelDiffStats | null;
  refresh: () => Promise<void>;
  runRemoteAction: (
    mode?: RepositoryRemoteActionMode,
  ) => Promise<RepositoryRemoteActionResult>;
};

const snapshots = createSnapshotCache<RepositoryControllerState>(16);

type RepositoryControllerState = {
  contextPath: string | null;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  localError: string | null;
  busyAction: RepositoryRemoteAction | null;
  lastRemoteError: string | null;
  revision: number;
  graphRevision: string | null;
  diffStats: GitPanelDiffStats | null;
};

function isPathInsideRepository(
  cwd: string | null,
  repoRoot: string,
  workspace: WorkspaceEnv,
): boolean {
  if (!cwd) return false;
  const current = documentPathIdentity(workspace, cwd).replace(/\/$/, "");
  const root = documentPathIdentity(workspace, repoRoot).replace(/\/$/, "");
  return current === root || current.startsWith(`${root}/`);
}

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown source control error";
}

function getContextualAction(
  status: GitStatusSnapshot | null,
): RepositoryRemoteAction | null {
  if (!status?.upstream) return null;
  if (status.ahead > 0 && status.behind > 0) return null;
  if (status.behind > 0) return "pull";
  if (status.ahead > 0) return "push";
  return "fetch";
}

/**
 * 维护当前工作区上下文对应的唯一 Git 仓库快照。
 *
 * 本地事件、恢复校验与 Git 操作共用串行队列，统计不另建请求链。
 */
export function useRepositoryController(
  contextPath: string | null,
  requestedEnabled: boolean = true,
  foreground: boolean = true,
): RepositoryController {
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const workspaceKey = workspaceScopeKey(workspaceEnv);
  const runtime = useRemoteRuntimeStore((s) => s.snapshot);
  const epoch =
    workspaceEnv.kind !== "ssh"
      ? "native"
      : runtime.phase === "connected" &&
          runtime.profileId === workspaceEnv.profileId
        ? runtime.epoch
        : null;
  const enabled = useViewActive(requestedEnabled && epoch !== null);
  const epochRef = useRef(epoch);
  epochRef.current = epoch;
  const [state, setState] = useState<RepositoryControllerState>({
    contextPath: null,
    repo: null,
    status: null,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    revision: 0,
    graphRevision: null,
    diffStats: null,
  });
  const stateRef = useRef(state);
  const requestIdRef = useRef(0);
  const enabledRef = useRef(enabled);
  const contextPathRef = useRef(contextPath);
  const workspaceKeyRef = useRef(workspaceKey);
  const lastRefreshAtRef = useRef(0);
  const foregroundRef = useRef(foreground);
  const previousForegroundRef = useRef(foreground);
  const lastDurationRef = useRef(0);
  const schedulePollRef = useRef(() => {});
  const mountedRef = useRef(true);
  const dirtyRef = useRef(false);

  foregroundRef.current = foreground;
  enabledRef.current = enabled;
  contextPathRef.current = contextPath;
  workspaceKeyRef.current = workspaceKey;

  const updateState = useCallback(
    (
      update:
        | RepositoryControllerState
        | ((current: RepositoryControllerState) => RepositoryControllerState),
    ) => {
      const next =
        typeof update === "function" ? update(stateRef.current) : update;
      if (next === stateRef.current) return;
      stateRef.current = next;
      setState(next);
    },
    [],
  );

  useEffect(() => {
    void epoch;
    requestIdRef.current++;
    lastRefreshAtRef.current = 0;
    lastDurationRef.current = 0;
    dirtyRef.current = true;
    updateState(
      snapshots.get(`${workspaceKey}\0${contextPath}`) ?? {
        contextPath: null,
        repo: null,
        status: null,
        localError: null,
        busyAction: null,
        lastRemoteError: null,
        revision: 0,
        graphRevision: null,
        diffStats: null,
      },
    );
  }, [updateState, workspaceKey, contextPath, epoch]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const doRefresh = useCallback(async (): Promise<void> => {
    if (!mountedRef.current || !enabledRef.current || !isWindowVisible())
      return;
    const startedAt = Date.now();
    const requestId = ++requestIdRef.current;
    const requestedContext = contextPathRef.current;
    const requestedWorkspace = workspaceKeyRef.current;
    const requestedEpoch = epochRef.current;
    const includeGraph = foregroundRef.current;
    const isCurrentRequest = () =>
      mountedRef.current &&
      requestId === requestIdRef.current &&
      enabledRef.current &&
      contextPathRef.current === requestedContext &&
      workspaceKeyRef.current === requestedWorkspace &&
      epochRef.current === requestedEpoch;

    if (!requestedContext) {
      updateState((current) =>
        current.contextPath === null
          ? current
          : {
              ...current,
              contextPath: null,
              repo: null,
              status: null,
              diffStats: null,
              graphRevision: null,
              localError: null,
              busyAction: null,
              lastRemoteError: null,
            },
      );
      return;
    }

    try {
      const cacheKey = `${requestedWorkspace}\0${requestedContext}`;
      const snapshot = await readViewResource(
        `git-snapshot:${cacheKey}:${requestedEpoch}:${includeGraph}`,
        () => native.gitPanelSnapshot(requestedContext, includeGraph),
      );
      if (!mountedRef.current || epochRef.current !== requestedEpoch) return;
      const cached = snapshots.get(cacheKey);
      const graphRevision = snapshot.repo
        ? ((snapshot.graphRevision === "unavailable"
            ? null
            : snapshot.graphRevision) ??
          (cached?.repo?.repoRoot === snapshot.repo.repoRoot
            ? cached.graphRevision
            : null) ??
          (includeGraph ? "unavailable" : null))
        : null;
      snapshots.set(cacheKey, {
        contextPath: requestedContext,
        repo: snapshot.repo,
        status: snapshot.status,
        graphRevision,
        diffStats:
          cached?.repo?.repoRoot === snapshot.repo?.repoRoot
            ? (cached?.diffStats ?? null)
            : null,
        revision: (cached?.revision ?? 0) + 1,
        localError: null,
        busyAction: null,
        lastRemoteError: null,
      });
      if (!isCurrentRequest()) return;
      if (!snapshot.repo || !snapshot.status) {
        updateState((current) =>
          current.contextPath === requestedContext &&
          current.repo === null &&
          current.localError === null
            ? current
            : {
                ...current,
                contextPath: requestedContext,
                repo: null,
                status: null,
                graphRevision: null,
                diffStats: null,
                localError: null,
              },
        );
        return;
      }
      const previous = stateRef.current;
      const shared = shareRepositorySnapshot(previous, snapshot);
      const repo = shared.repo ?? snapshot.repo;
      const status = shared.status ?? snapshot.status;

      updateState((current) => ({
        ...current,
        contextPath: requestedContext,
        repo,
        status,
        revision: current.revision + 1,
        // 瞬时引用错误不替换已知摘要，首次失败仍允许历史区域加载。
        graphRevision,
        diffStats:
          current.repo?.repoRoot === repo.repoRoot ? current.diffStats : null,
        localError: null,
      }));
      // 清单先显示，统计沿用本轮状态；慢统计计入周期，不能与下一轮自动读取重叠。
      if (foregroundRef.current && isWindowVisible() && isCurrentRequest()) {
        try {
          const stats = await native.gitPanelDiffStats(
            repo.repoRoot,
            snapshot.status,
          );
          const cached = snapshots.get(cacheKey);
          if (
            epochRef.current === requestedEpoch &&
            cached?.status === snapshot.status
          )
            snapshots.set(cacheKey, { ...cached, diffStats: stats });
          if (
            isCurrentRequest() &&
            foregroundRef.current &&
            isWindowVisible()
          ) {
            updateState((current) => ({
              ...current,
              diffStats: shareDiffStats(current.diffStats, stats),
            }));
          }
        } catch {
          // 展示统计失败不覆盖已成功读取的仓库状态。
          if (isCurrentRequest())
            updateState((current) => ({ ...current, diffStats: null }));
        }
      }
    } catch (error) {
      if (!isCurrentRequest()) return;
      const localError = normalizeError(error);
      updateState((current) => {
        if (current.contextPath === requestedContext)
          return current.localError === localError
            ? current
            : { ...current, localError };
        return {
          ...current,
          contextPath: requestedContext,
          repo: null,
          status: null,
          graphRevision: null,
          diffStats: null,
          localError,
        };
      });
    } finally {
      if (isCurrentRequest()) {
        lastDurationRef.current = Date.now() - startedAt;
        lastRefreshAtRef.current = Date.now();
        schedulePollRef.current();
      }
    }
  }, [updateState]);

  const refreshQueue = useMemo(
    () =>
      createRepositoryRefreshQueue(doRefresh, () =>
        stateRef.current.contextPath === contextPathRef.current
          ? Math.max(120, lastDurationRef.current)
          : 0,
      ),
    [doRefresh],
  );
  useEffect(() => () => refreshQueue.cancelPending(), [refreshQueue]);

  const refresh = useCallback(() => {
    if (!enabledRef.current || !isWindowVisible()) {
      dirtyRef.current = true;
      return Promise.resolve();
    }
    dirtyRef.current = false;
    return refreshQueue.request();
  }, [refreshQueue]);

  const check = useCallback(() => {
    if (
      stateRef.current.contextPath !== contextPathRef.current ||
      dirtyRef.current
    )
      return refresh();
    if (Date.now() - lastRefreshAtRef.current < SC_STATUS_TTL_MS)
      return Promise.resolve();
    return refreshQueue.request("check");
  }, [refresh, refreshQueue]);

  const runRemoteAction = useCallback(
    async (
      mode: RepositoryRemoteActionMode = "contextual",
    ): Promise<RepositoryRemoteActionResult> => {
      const { repo, status } = stateRef.current;
      if (!repo || !status) {
        return { ok: false, action: null, blocked: "no-repo" };
      }
      if (!status.upstream) {
        return { ok: false, action: null, blocked: "missing-upstream" };
      }

      const action = mode === "contextual" ? getContextualAction(status) : mode;
      if (!action) {
        return { ok: false, action: null, blocked: "diverged" };
      }

      updateState((current) => ({ ...current, busyAction: action }));

      try {
        if (action === "fetch") {
          await native.gitFetch(repo.repoRoot);
        } else if (action === "pull") {
          await native.gitFetch(repo.repoRoot);
          await native.gitPullFfOnly(repo.repoRoot);
        } else {
          await native.gitPush(repo.repoRoot);
        }
        updateState((current) => ({ ...current, lastRemoteError: null }));
        await refresh();
        return { ok: true, action };
      } catch (error) {
        const message = normalizeError(error);
        updateState((current) => ({
          ...current,
          lastRemoteError: message,
        }));
        await refresh().catch(() => {});
        return { ok: false, action, error: message };
      } finally {
        updateState((current) => ({ ...current, busyAction: null }));
      }
    },
    [refresh, updateState],
  );

  useEffect(() => {
    void workspaceKey;
    void contextPath;
    void epoch;
    if (!enabled) {
      refreshQueue.cancelPending();
      dirtyRef.current = true;
      return;
    }
    updateState((current) =>
      current.lastRemoteError === null
        ? current
        : { ...current, lastRemoteError: null },
    );
    const run = () => {
      void refresh();
    };
    const idle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(run, { timeout: 600 })
        : (window.setTimeout(run, 0) as unknown as number);
    return () => {
      if (typeof window.cancelIdleCallback === "function") {
        try {
          window.cancelIdleCallback(idle as number);
        } catch {
          /* 忽略已失效的 idle 回调 */
        }
      } else {
        window.clearTimeout(idle as number);
      }
    };
  }, [
    refresh,
    refreshQueue,
    contextPath,
    enabled,
    updateState,
    workspaceKey,
    epoch,
  ]);

  useEffect(() => {
    if (!enabled || !contextPath) return;
    return subscribeTerminalCommandFinished((cwd) => {
      const currentRepoRoot =
        stateRef.current.contextPath === contextPath
          ? stateRef.current.repo?.repoRoot
          : null;
      if (
        currentRepoRoot &&
        isPathInsideRepository(cwd, currentRepoRoot, workspaceEnv)
      ) {
        void refresh();
      }
    });
  }, [enabled, contextPath, refresh, workspaceEnv]);

  useEffect(() => {
    if (!enabled || !contextPath) return;
    let timer = 0;
    let firstEventAt: number | null = null;
    const schedule = (paths: string[]) => {
      const root =
        stateRef.current.contextPath === contextPath
          ? (stateRef.current.repo?.repoRoot ?? contextPath)
          : contextPath;
      if (
        root &&
        !paths.some(
          (path) =>
            isPathInsideRepository(path, root, workspaceEnv) ||
            isPathInsideRepository(root, path, workspaceEnv),
        )
      )
        return;
      dirtyRef.current = true;
      window.clearTimeout(timer);
      if (!isWindowVisible()) return;
      firstEventAt ??= Date.now();
      timer = window.setTimeout(
        () => {
          timer = 0;
          firstEventAt = null;
          // 恢复校验可能已消费此批失效；等待期间隐藏则留到下次恢复。
          if (dirtyRef.current && isWindowVisible()) void refresh();
        },
        Math.min(120, Math.max(0, firstEventAt + 1000 - Date.now())),
      );
    };
    const unsubscribe = subscribeFileSystemChanges(workspaceEnv, schedule);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, contextPath, refresh, workspaceEnv]);

  useEffect(() => {
    // 可见性切换立即重排间隔，不能等后台的旧计时器耗尽。
    void foreground;
    if (!enabled || !contextPath) return;
    let disposed = false;
    let running = false;
    let timer = 0;
    const canRefresh = () => !disposed && isWindowVisible();
    const schedule = () => {
      window.clearTimeout(timer);
      timer = 0;
      if (!canRefresh() || running) return;
      timer = window.setTimeout(
        () => {
          timer = 0;
          void run();
        },
        Math.max(
          foregroundRef.current ? FOREGROUND_REFRESH_MS : BACKGROUND_REFRESH_MS,
          lastDurationRef.current,
        ),
      );
    };
    const run = async () => {
      if (!canRefresh()) return;
      // 先接收恢复产生的失效，再复用等待者，不能因旧轮询未结束而漏查。
      const task = check();
      if (running) return;
      running = true;
      try {
        await task;
      } finally {
        running = false;
        schedule();
      }
    };
    schedulePollRef.current = schedule;
    const unsubscribeResume = subscribeWorkspaceResume(() => {
      window.clearTimeout(timer);
      timer = 0;
      void run();
    });
    const onVisibility = () => {
      if (!canRefresh()) {
        // 隐藏期间可能没有文件事件，恢复时不能复用隐藏前的短期快照。
        dirtyRef.current = true;
        window.clearTimeout(timer);
        timer = 0;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      schedulePollRef.current = () => {};
      document.removeEventListener("visibilitychange", onVisibility);
      disposed = true;
      if (timer) window.clearTimeout(timer);
      unsubscribeResume();
    };
  }, [contextPath, enabled, check, foreground]);

  useEffect(() => {
    const activated = foreground && !previousForegroundRef.current;
    previousForegroundRef.current = foreground;
    if (activated && enabled && contextPath) void refresh();
  }, [foreground, enabled, contextPath, refresh]);

  return useMemo<RepositoryController>(() => {
    const current =
      state.contextPath === contextPath
        ? state
        : snapshots.get(`${workspaceKey}\0${contextPath}`);
    const repo = contextPath ? (current?.repo ?? null) : null;
    const status = contextPath ? (current?.status ?? null) : null;
    return {
      repo,
      status,
      changedCount: status?.changedFiles.length ?? 0,
      upstream: status?.upstream ?? repo?.upstream ?? null,
      ahead: status?.ahead ?? 0,
      behind: status?.behind ?? 0,
      hasRepo: repo !== null,
      isLoading:
        enabled && !!contextPath && current?.contextPath !== contextPath,
      localError: contextPath ? (current?.localError ?? null) : null,
      busyAction: current?.busyAction ?? null,
      lastRemoteError: current?.lastRemoteError ?? null,
      revision: current?.revision ?? 0,
      graphRevision: repo ? (current?.graphRevision ?? null) : null,
      diffStats: repo ? (current?.diffStats ?? null) : null,
      refresh,
      runRemoteAction,
    };
  }, [state, enabled, contextPath, workspaceKey, refresh, runRemoteAction]);
}
