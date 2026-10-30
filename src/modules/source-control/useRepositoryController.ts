/**
 * 本文件维护工作区当前 Git 仓库的唯一控制器。
 * 所有调用方共享真实快照与单调 revision；工作区状态与 Git 引用分别合并刷新。
 */

import { documentPathIdentity } from "@/lib/pathIdentity";
import {
  type GitRepoInfo,
  type GitStatusSnapshot,
  native,
} from "@/modules/ai/lib/native";
import {
  subscribeFileSystemChanges,
  subscribeWorkspaceResume,
} from "@/modules/filesystem";
import { subscribeTerminalCommandFinished } from "@/modules/terminal/lib/commandCompletion";
import {
  useWorkspaceEnvStore,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRepositoryRefreshQueue } from "./repositoryRefresh";
import { shareRepositorySnapshot } from "./repositorySharing";

// 相同上下文在短时间内复用快照；路径一旦变化就重新发现仓库，避免漏掉嵌套仓库。
const SC_STATUS_TTL_MS = 2000;
const FOREGROUND_REFRESH_MS = 3000;
const MAX_REFRESH_MS = 30000;

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
  /** 同一上下文已有仓库内容的刷新，不替换为首次加载占位。 */
  isRefreshing: boolean;
  localError: string | null;
  busyAction: RepositoryRemoteAction | null;
  lastRemoteError: string | null;
  /** 每次成功读取真实仓库快照后递增，供可见派生视图重新加载。 */
  revision: number;
  /** Git 引用摘要；首次 probe 完成前为空，避免加载存在竞态的提交图。 */
  graphRevision: string | null;
  refresh: () => Promise<void>;
  runRemoteAction: (
    mode?: RepositoryRemoteActionMode,
  ) => Promise<RepositoryRemoteActionResult>;
};

type RepositoryControllerState = {
  contextPath: string | null;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  localError: string | null;
  busyAction: RepositoryRemoteAction | null;
  lastRemoteError: string | null;
  revision: number;
  graphRevision: string | null;
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
 * 本地事件和 Git 操作共用状态刷新队列；引用 probe 独立合并，避免普通文件事件重读提交图。
 */
export function useRepositoryController(
  contextPath: string | null,
  enabled: boolean = true,
): RepositoryController {
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const workspaceKey = workspaceScopeKey(workspaceEnv);
  const [refreshing, setRefreshing] = useState(false);
  const [state, setState] = useState<RepositoryControllerState>({
    contextPath: null,
    repo: null,
    status: null,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    revision: 0,
    graphRevision: null,
  });
  const stateRef = useRef(state);
  const requestIdRef = useRef(0);
  const enabledRef = useRef(enabled);
  const contextPathRef = useRef(contextPath);
  const workspaceKeyRef = useRef(workspaceKey);
  const lastRefreshAtRef = useRef(0);
  const pollDelayRef = useRef(FOREGROUND_REFRESH_MS);
  const dirtyRef = useRef(false);

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
    void workspaceKey;
    requestIdRef.current++;
    lastRefreshAtRef.current = 0;
    updateState({
      contextPath: null,
      repo: null,
      status: null,
      localError: null,
      busyAction: null,
      lastRemoteError: null,
      revision: 0,
      graphRevision: null,
    });
  }, [updateState, workspaceKey]);

  const doRefresh = useCallback(async (): Promise<void> => {
    if (!enabledRef.current) return;
    const startedAt = Date.now();
    const requestId = ++requestIdRef.current;
    const requestedContext = contextPathRef.current;
    const requestedWorkspace = workspaceKeyRef.current;
    const isCurrentRequest = () =>
      requestId === requestIdRef.current &&
      enabledRef.current &&
      contextPathRef.current === requestedContext &&
      workspaceKeyRef.current === requestedWorkspace;

    if (!requestedContext) {
      updateState((current) =>
        current.contextPath === null
          ? current
          : {
              ...current,
              contextPath: null,
              repo: null,
              status: null,
              localError: null,
              busyAction: null,
              lastRemoteError: null,
            },
      );
      return;
    }

    try {
      setRefreshing(
        stateRef.current.repo !== null &&
          stateRef.current.contextPath === requestedContext,
      );
      const snapshot = await native.gitPanelSnapshot(requestedContext);
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
                localError: null,
              },
        );
        return;
      }
      const previous = stateRef.current;
      const shared = shareRepositorySnapshot(previous, snapshot);
      const repo = shared.repo ?? snapshot.repo;
      const status = shared.status ?? snapshot.status;
      const unchanged = previous.repo === repo && previous.status === status;
      pollDelayRef.current = Math.min(
        MAX_REFRESH_MS,
        Math.max(
          FOREGROUND_REFRESH_MS,
          (Date.now() - startedAt) * 2,
          unchanged ? pollDelayRef.current * 2 : FOREGROUND_REFRESH_MS,
        ),
      );

      updateState((current) => ({
        ...current,
        contextPath: requestedContext,
        repo,
        status,
        revision: current.revision + 1,
        graphRevision:
          current.repo?.repoRoot === repo.repoRoot
            ? current.graphRevision
            : null,
        localError: null,
      }));
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
          localError,
        };
      });
    } finally {
      setRefreshing(false);
      if (isCurrentRequest()) lastRefreshAtRef.current = Date.now();
    }
  }, [updateState]);

  const refreshQueue = useMemo(
    () => createRepositoryRefreshQueue(doRefresh),
    [doRefresh],
  );

  const refresh = useCallback(() => {
    pollDelayRef.current = FOREGROUND_REFRESH_MS;
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

  const probeGraphRevision = useCallback(async (): Promise<void> => {
    const repoRoot = stateRef.current.repo?.repoRoot;
    const requestedWorkspace = workspaceKeyRef.current;
    if (!enabledRef.current || !repoRoot) return;
    try {
      const signature = await native.gitGraphRevision(repoRoot);
      if (
        !enabledRef.current ||
        stateRef.current.repo?.repoRoot !== repoRoot ||
        workspaceKeyRef.current !== requestedWorkspace
      ) {
        return;
      }
      updateState((current) =>
        current.graphRevision === signature
          ? current
          : { ...current, graphRevision: signature },
      );
    } catch {
      // 首次 probe 失败也允许 Graph 加载；后续语义事件会再次校验。
      if (
        enabledRef.current &&
        stateRef.current.repo?.repoRoot === repoRoot &&
        workspaceKeyRef.current === requestedWorkspace &&
        stateRef.current.graphRevision === null
      ) {
        updateState((current) => ({
          ...current,
          graphRevision: "unavailable",
        }));
      }
    }
  }, [updateState]);

  const graphProbeQueue = useMemo(
    () => createRepositoryRefreshQueue(probeGraphRevision),
    [probeGraphRevision],
  );
  const probeGraph = useCallback(
    () => graphProbeQueue.request(),
    [graphProbeQueue],
  );

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
        await probeGraph();
        return { ok: true, action };
      } catch (error) {
        const message = normalizeError(error);
        updateState((current) => ({
          ...current,
          lastRemoteError: message,
        }));
        await refresh().catch(() => {});
        await probeGraph();
        return { ok: false, action, error: message };
      } finally {
        updateState((current) => ({ ...current, busyAction: null }));
      }
    },
    [probeGraph, refresh, updateState],
  );

  const repoRoot = state.repo?.repoRoot ?? null;
  useEffect(() => {
    if (!repoRoot) return;
    void probeGraph();
  }, [probeGraph, repoRoot]);

  useEffect(() => {
    void workspaceKey;
    if (!enabled) {
      requestIdRef.current++;
      updateState({
        contextPath: null,
        repo: null,
        status: null,
        localError: null,
        busyAction: null,
        lastRemoteError: null,
        revision: 0,
        graphRevision: null,
      });
      return;
    }
    updateState((current) =>
      current.lastRemoteError === null
        ? current
        : { ...current, lastRemoteError: null },
    );
    const run = () => {
      const fresh = Date.now() - lastRefreshAtRef.current < SC_STATUS_TTL_MS;
      if (
        fresh &&
        contextPath === stateRef.current.contextPath &&
        stateRef.current.repo
      ) {
        return;
      }
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
  }, [refresh, contextPath, enabled, updateState, workspaceKey]);

  useEffect(() => {
    if (!enabled) return;
    return subscribeTerminalCommandFinished((cwd) => {
      const currentRepoRoot = stateRef.current.repo?.repoRoot;
      if (
        currentRepoRoot &&
        isPathInsideRepository(cwd, currentRepoRoot, workspaceEnv)
      ) {
        void probeGraph();
        void refresh();
      }
    });
  }, [enabled, probeGraph, refresh, workspaceEnv]);

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const schedule = (paths: string[]) => {
      const root = stateRef.current.repo?.repoRoot;
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
      pollDelayRef.current = FOREGROUND_REFRESH_MS;
      window.clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      timer = window.setTimeout(() => {
        timer = 0;
        // 恢复校验可能已消费此批失效；等待期间隐藏则留到下次恢复。
        if (dirtyRef.current && document.visibilityState !== "hidden")
          void refresh();
      }, 120);
    };
    const unsubscribe = subscribeFileSystemChanges(workspaceEnv, schedule);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, refresh, workspaceEnv]);

  useEffect(() => {
    if (!enabled || !contextPath) return;
    let disposed = false;
    let running = false;
    let timer = 0;
    const canRefresh = () => !disposed && document.visibilityState !== "hidden";
    const schedule = () => {
      window.clearTimeout(timer);
      timer = 0;
      if (!canRefresh()) return;
      timer = window.setTimeout(() => {
        timer = 0;
        void run();
      }, pollDelayRef.current);
    };
    const run = async () => {
      if (!canRefresh() || running) return;
      running = true;
      try {
        await Promise.all([check(), graphProbeQueue.request("check")]);
      } finally {
        running = false;
        schedule();
      }
    };
    const unsubscribeResume = subscribeWorkspaceResume(() => {
      window.clearTimeout(timer);
      timer = 0;
      void run();
    });
    schedule();
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      unsubscribeResume();
    };
  }, [contextPath, enabled, check, graphProbeQueue]);

  return useMemo<RepositoryController>(() => {
    // 空 Space 没有仓库，不能在异步清理完成前继续暴露上一根目录的快照。
    const repo = contextPath ? state.repo : null;
    const status = contextPath ? state.status : null;
    return {
      repo,
      status,
      changedCount: status?.changedFiles.length ?? 0,
      upstream: status?.upstream ?? repo?.upstream ?? null,
      ahead: status?.ahead ?? 0,
      behind: status?.behind ?? 0,
      hasRepo: repo !== null,
      isLoading: enabled && !!contextPath && state.contextPath !== contextPath,
      isRefreshing:
        refreshing && repo !== null && state.contextPath === contextPath,
      localError: contextPath ? state.localError : null,
      busyAction: state.busyAction,
      lastRemoteError: state.lastRemoteError,
      revision: state.revision,
      graphRevision: repo ? state.graphRevision : null,
      refresh,
      runRemoteAction,
    };
  }, [state, refreshing, enabled, contextPath, refresh, runRemoteAction]);
}
