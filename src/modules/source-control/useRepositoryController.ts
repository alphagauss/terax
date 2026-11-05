/**
 * 本文件维护工作区当前 Git 仓库的唯一控制器。
 * 所有调用方共享真实快照与单调 revision；基础状态先发布，引用与可见统计共用串行刷新周期。
 */

import i18n from "@/i18n";
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
import { SC_AUTO_REFRESH_LIMIT } from "./sourceControlLimits";

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
  cancelled?: boolean;
  blocked?: "diverged" | "missing-upstream" | "no-repo" | "busy";
};

type RemoteOperation = {
  id: string;
  action: RepositoryRemoteAction;
  startedAt: number;
  phase: "running" | "cancelling" | "success" | "cancelled" | "error";
  cancelError?: string;
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
  remoteOperation: RemoteOperation | null;
  /** 每次成功读取真实仓库快照后递增，供可见派生视图重新加载。 */
  revision: number;
  /** Git 引用摘要；首次引用校验完成前为空，避免加载存在竞态的提交图。 */
  graphRevision: string | null;
  diffStats: GitPanelDiffStats | null;
  refresh: () => Promise<void>;
  cancelRemoteAction: () => Promise<void>;
  runRemoteAction: (
    mode?: RepositoryRemoteActionMode,
  ) => Promise<RepositoryRemoteActionResult>;
};

const snapshots = createSnapshotCache<RepositoryControllerState>(16);
// 同一 Workspace 的视图共用失效序号，写操作前开始的读取不得回填共享缓存。
const mutationRevisions = new Map<string, number>();

type RepositoryControllerState = {
  contextPath: string | null;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  localError: string | null;
  busyAction: RepositoryRemoteAction | null;
  lastRemoteError: string | null;
  remoteOperation: RemoteOperation | null;
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
  const detail =
    typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "Unknown source control error";
  return detail === "git_remote_operation_busy"
    ? i18n.t("sourceControl:remoteActionBusy")
    : detail;
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
    remoteOperation: null,
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
  // 显式刷新可以越过大量改动保护，并在隐藏期间保留到恢复；自动补查执行时仍需重新判断。
  const explicitRefreshRef = useRef(false);
  const remoteActionsRef = useRef(new Map<string, RemoteOperation>());
  const isAutoRefreshPaused = useCallback(
    () =>
      !explicitRefreshRef.current &&
      stateRef.current.contextPath === contextPathRef.current &&
      lastRefreshAtRef.current > 0 &&
      (stateRef.current.status?.changedFiles.length ?? 0) >
        SC_AUTO_REFRESH_LIMIT,
    [],
  );

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
        remoteOperation: null,
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

  const doRefresh = useCallback(
    async (snapshotReady: () => void) => {
      if (!mountedRef.current || !enabledRef.current || !isWindowVisible())
        return;
      if (isAutoRefreshPaused()) return;
      explicitRefreshRef.current = false;
      const startedAt = Date.now();
      const requestId = ++requestIdRef.current;
      const requestedContext = contextPathRef.current;
      const requestedWorkspace = workspaceKeyRef.current;
      const requestedEpoch = epochRef.current;
      const mutationRevision = mutationRevisions.get(requestedWorkspace) ?? 0;
      const isCurrentRevision = () =>
        (mutationRevisions.get(requestedWorkspace) ?? 0) === mutationRevision;
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
                remoteOperation: null,
              },
        );
        return;
      }

      try {
        const cacheKey = `${requestedWorkspace}\0${requestedContext}`;
        // 序号进入共享请求身份，操作后的校验只复用操作结束后启动的读取。
        const snapshot = await readViewResource(
          `git-snapshot:${cacheKey}:${requestedEpoch}:${includeGraph}:${mutationRevision}`,
          () => native.gitPanelSnapshot(requestedContext, includeGraph),
        );
        if (!mountedRef.current || epochRef.current !== requestedEpoch) return;
        if (!isCurrentRevision()) {
          if (isCurrentRequest()) dirtyRef.current = true;
          return;
        }
        const cached = snapshots.get(cacheKey);
        const largeChanges =
          (snapshot.status?.changedFiles.length ?? 0) > SC_AUTO_REFRESH_LIMIT;
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
            !largeChanges && cached?.repo?.repoRoot === snapshot.repo?.repoRoot
              ? (cached?.diffStats ?? null)
              : null,
          revision: (cached?.revision ?? 0) + 1,
          localError: null,
          busyAction: null,
          lastRemoteError: null,
          remoteOperation: null,
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
        const activeOperation = remoteActionsRef.current.get(
          `${requestedWorkspace}\0${repo.repoRoot}`,
        );

        updateState((current) => ({
          ...current,
          contextPath: requestedContext,
          repo,
          status,
          busyAction: activeOperation?.action ?? null,
          remoteOperation:
            activeOperation ??
            (current.repo?.repoRoot === repo.repoRoot &&
            current.remoteOperation?.phase !== "running" &&
            current.remoteOperation?.phase !== "cancelling"
              ? current.remoteOperation
              : null),
          revision: current.revision + 1,
          // 瞬时引用错误不替换已知摘要，首次失败仍允许历史区域加载。
          graphRevision,
          diffStats:
            !largeChanges && current.repo?.repoRoot === repo.repoRoot
              ? current.diffStats
              : null,
          localError: null,
        }));
        snapshotReady();
        // 清单先显示，统计沿用本轮状态；慢统计计入周期，不能与下一轮自动读取重叠。
        if (
          !largeChanges &&
          foregroundRef.current &&
          isWindowVisible() &&
          isCurrentRequest()
        ) {
          try {
            const stats = await native.gitPanelDiffStats(
              repo.repoRoot,
              snapshot.status,
            );
            if (!isCurrentRevision()) {
              if (isCurrentRequest()) dirtyRef.current = true;
              return;
            }
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
            if (isCurrentRequest() && isCurrentRevision())
              updateState((current) => ({ ...current, diffStats: null }));
          }
        }
      } catch (error) {
        if (!isCurrentRequest() || !isCurrentRevision()) return;
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
    },
    [updateState, isAutoRefreshPaused],
  );

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

  const refresh = useCallback(
    (explicit = true, snapshotOnly = false) => {
      if (!explicit && isAutoRefreshPaused()) return Promise.resolve();
      explicitRefreshRef.current ||= explicit;
      if (!enabledRef.current || !isWindowVisible()) {
        dirtyRef.current = true;
        return Promise.resolve();
      }
      dirtyRef.current = false;
      return refreshQueue.request(snapshotOnly ? "mutation" : "invalidate");
    },
    [refreshQueue, isAutoRefreshPaused],
  );

  const check = useCallback(() => {
    if (isAutoRefreshPaused()) return Promise.resolve();
    if (
      stateRef.current.contextPath !== contextPathRef.current ||
      dirtyRef.current
    )
      return refresh(false);
    if (Date.now() - lastRefreshAtRef.current < SC_STATUS_TTL_MS)
      return Promise.resolve();
    return refreshQueue.request("check");
  }, [refresh, refreshQueue, isAutoRefreshPaused]);

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

      const requestedWorkspace = workspaceKeyRef.current;
      const requestedEpoch = epochRef.current;
      const operationKey = `${requestedWorkspace}\0${repo.repoRoot}`;
      if (remoteActionsRef.current.has(operationKey)) {
        return { ok: false, action, blocked: "busy" };
      }
      const isCurrentAction = () =>
        mountedRef.current &&
        stateRef.current.contextPath === contextPathRef.current &&
        stateRef.current.repo?.repoRoot === repo.repoRoot &&
        workspaceKeyRef.current === requestedWorkspace &&
        epochRef.current === requestedEpoch;
      const operationId = crypto.randomUUID();
      const operation: RemoteOperation = {
        id: operationId,
        action,
        startedAt: Date.now(),
        phase: "running",
      };
      remoteActionsRef.current.set(operationKey, operation);
      updateState((current) => ({
        ...current,
        busyAction: action,
        lastRemoteError: null,
        remoteOperation: operation,
      }));
      const finishOperation = (
        phase: RemoteOperation["phase"],
        error: string | null,
      ) => {
        const finished: RemoteOperation = { ...operation, phase };
        remoteActionsRef.current.set(operationKey, finished);
        if (isCurrentAction())
          updateState((current) => ({
            ...current,
            lastRemoteError: error,
            remoteOperation: finished,
          }));
      };

      let result: RepositoryRemoteActionResult;
      try {
        if (action === "fetch") {
          await native.gitFetch(repo.repoRoot, operationId);
        } else if (action === "pull") {
          await native.gitPullFfOnly(repo.repoRoot, operationId);
        } else {
          await native.gitPush(repo.repoRoot, operationId);
        }
        finishOperation("success", null);
        result = { ok: true, action };
      } catch (error) {
        const message = normalizeError(error);
        const cancelled = message === "git_operation_cancelled";
        finishOperation(
          cancelled ? "cancelled" : "error",
          cancelled ? null : message,
        );
        result = cancelled
          ? { ok: false, action, cancelled: true }
          : { ok: false, action, error: message };
      }
      mutationRevisions.set(
        requestedWorkspace,
        (mutationRevisions.get(requestedWorkspace) ?? 0) + 1,
      );
      try {
        // 操作结果独立于刷新结果；只等待操作后的快照，不等待行数统计或后续事件。
        if (isCurrentAction()) await refresh(true, true);
      } finally {
        remoteActionsRef.current.delete(operationKey);
        if (isCurrentAction())
          updateState((current) => ({ ...current, busyAction: null }));
      }
      return result;
    },
    [refresh, updateState],
  );

  const cancelRemoteAction = useCallback(async () => {
    const operation = stateRef.current.remoteOperation;
    if (operation?.phase !== "running") return;
    const requestedContext = contextPathRef.current;
    const requestedWorkspace = workspaceKeyRef.current;
    const requestedEpoch = epochRef.current;
    const key = `${requestedWorkspace}\0${stateRef.current.repo?.repoRoot}`;
    const isCurrent = () =>
      mountedRef.current &&
      contextPathRef.current === requestedContext &&
      workspaceKeyRef.current === requestedWorkspace &&
      epochRef.current === requestedEpoch;
    const updateOperation = (next: RemoteOperation) => {
      remoteActionsRef.current.set(key, next);
      if (isCurrent())
        updateState((current) => ({ ...current, remoteOperation: next }));
    };
    updateOperation({
      ...operation,
      phase: "cancelling",
      cancelError: undefined,
    });
    const stillCancelling = () => {
      const active = remoteActionsRef.current.get(key);
      return active?.id === operation.id && active.phase === "cancelling";
    };
    try {
      const accepted = await native.gitCancelRemoteOperation(operation.id);
      if (!accepted && stillCancelling())
        updateOperation({
          ...operation,
          phase: "running",
          cancelError: i18n.t("sourceControl:remote.notReady"),
        });
    } catch (error) {
      if (stillCancelling())
        updateOperation({
          ...operation,
          phase: "running",
          cancelError: i18n.t("sourceControl:remote.cancelFailed", {
            error: normalizeError(error),
          }),
        });
    }
  }, [updateState]);

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
      void refresh(false);
    };
    const timer = window.setTimeout(run, 0);
    return () => window.clearTimeout(timer);
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
        void refresh(false);
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
      if (!isWindowVisible() || isAutoRefreshPaused()) return;
      firstEventAt ??= Date.now();
      timer = window.setTimeout(
        () => {
          timer = 0;
          firstEventAt = null;
          // 恢复校验可能已消费此批失效；等待期间隐藏则留到下次恢复。
          if (dirtyRef.current && isWindowVisible()) void refresh(false);
        },
        Math.min(120, Math.max(0, firstEventAt + 1000 - Date.now())),
      );
    };
    const unsubscribe = subscribeFileSystemChanges(workspaceEnv, schedule);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, contextPath, refresh, workspaceEnv, isAutoRefreshPaused]);

  useEffect(() => {
    // 可见性切换立即重排间隔，不能等后台的旧计时器耗尽。
    void foreground;
    if (!enabled || !contextPath) return;
    let disposed = false;
    let running = false;
    let timer = 0;
    const canRefresh = () =>
      !disposed && isWindowVisible() && !isAutoRefreshPaused();
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
  }, [contextPath, enabled, check, foreground, isAutoRefreshPaused]);

  useEffect(() => {
    const activated = foreground && !previousForegroundRef.current;
    previousForegroundRef.current = foreground;
    if (activated && enabled && contextPath) void refresh(false);
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
      remoteOperation: current?.remoteOperation ?? null,
      cancelRemoteAction,
      revision: current?.revision ?? 0,
      graphRevision: repo ? (current?.graphRevision ?? null) : null,
      diffStats: repo ? (current?.diffStats ?? null) : null,
      refresh,
      runRemoteAction,
    };
  }, [
    state,
    enabled,
    contextPath,
    workspaceKey,
    refresh,
    runRemoteAction,
    cancelRemoteAction,
  ]);
}
