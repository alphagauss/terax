/**
 * 本文件维护工作区当前 Git 仓库的唯一控制器。
 * 所有调用方共享真实快照与单调 revision；工作区状态与 Git 引用分别合并刷新。
 */

import {
  type GitPanelDiffStats,
  type GitRepoInfo,
  type GitStatusSnapshot,
  native,
} from "@/modules/ai/lib/native";
import { documentPathIdentity } from "@/lib/pathIdentity";
import { subscribeTerminalCommandFinished } from "@/modules/terminal/lib/commandCompletion";
import {
  type WorkspaceEnv,
  useWorkspaceEnvStore,
  workspaceScopeKey,
} from "@/modules/workspace";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRepositoryRefreshQueue } from "./repositoryRefresh";

const FOCUS_REFRESH_MIN_INTERVAL_MS = 1500;
// 相同上下文在短时间内复用快照；路径一旦变化就重新发现仓库，避免漏掉嵌套仓库。
const SC_STATUS_TTL_MS = 2000;

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
  diffStats: GitPanelDiffStats | null;
  changedCount: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRepo: boolean;
  isLoading: boolean;
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
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  diffStats: GitPanelDiffStats | null;
  isLoading: boolean;
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
  const [state, setState] = useState<RepositoryControllerState>({
    repo: null,
    status: null,
    diffStats: null,
    isLoading: false,
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
  const lastRefreshContextRef = useRef<string | null>(null);

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
      stateRef.current = next;
      setState(next);
    },
    [],
  );

  useEffect(() => {
    void workspaceKey;
    requestIdRef.current++;
    lastRefreshAtRef.current = 0;
    lastRefreshContextRef.current = null;
    updateState({
      repo: null,
      status: null,
      diffStats: null,
      isLoading: false,
      localError: null,
      busyAction: null,
      lastRemoteError: null,
      revision: 0,
      graphRevision: null,
    });
  }, [updateState, workspaceKey]);

  const doRefresh = useCallback(async (): Promise<void> => {
    if (!enabledRef.current) return;
    const requestId = ++requestIdRef.current;
    const requestedContext = contextPathRef.current;
    const requestedWorkspace = workspaceKeyRef.current;
    const isCurrentRequest = () =>
      requestId === requestIdRef.current &&
      enabledRef.current &&
      contextPathRef.current === requestedContext &&
      workspaceKeyRef.current === requestedWorkspace;

    if (!requestedContext) {
      updateState({
        repo: null,
        status: null,
        diffStats: null,
        isLoading: false,
        localError: null,
        busyAction: null,
        lastRemoteError: null,
        revision: stateRef.current.revision,
        graphRevision: stateRef.current.graphRevision,
      });
      return;
    }

    updateState((current) => ({
      ...current,
      isLoading: true,
      localError: null,
    }));

    try {
      const snapshot = await native.gitPanelSnapshot(requestedContext);
      if (!isCurrentRequest()) return;
      if (!snapshot.repo || !snapshot.status) {
        updateState((current) => ({
          ...current,
          repo: null,
          status: null,
          diffStats: null,
          isLoading: false,
          localError: null,
        }));
        lastRefreshAtRef.current = Date.now();
        lastRefreshContextRef.current = requestedContext;
        return;
      }
      const repo = snapshot.repo;
      const status = snapshot.status;

      updateState((current) => ({
        ...current,
        repo,
        status,
        diffStats: snapshot.diffStats,
        revision: current.revision + 1,
        graphRevision:
          current.repo?.repoRoot === repo.repoRoot
            ? current.graphRevision
            : null,
        isLoading: false,
        localError: null,
      }));
      lastRefreshAtRef.current = Date.now();
      lastRefreshContextRef.current = requestedContext;
    } catch (error) {
      if (!isCurrentRequest()) return;
      updateState((current) => ({
        ...current,
        repo: null,
        status: null,
        diffStats: null,
        isLoading: false,
        localError: normalizeError(error),
      }));
      lastRefreshAtRef.current = Date.now();
      lastRefreshContextRef.current = requestedContext;
    }
  }, [updateState]);

  const refreshQueue = useMemo(
    () => createRepositoryRefreshQueue(doRefresh),
    [doRefresh],
  );

  const refresh = useCallback(() => refreshQueue.request(), [refreshQueue]);

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
        repo: null,
        status: null,
        diffStats: null,
        isLoading: false,
        localError: null,
        busyAction: null,
        lastRemoteError: null,
        revision: 0,
        graphRevision: null,
      });
      return;
    }
    updateState((current) => ({ ...current, lastRemoteError: null }));
    const run = () => {
      const fresh = Date.now() - lastRefreshAtRef.current < SC_STATUS_TTL_MS;
      if (
        fresh &&
        contextPath === lastRefreshContextRef.current &&
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
    let timer = 0;
    const onFocus = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        void probeGraph();
        const elapsed = Date.now() - lastRefreshAtRef.current;
        if (elapsed < FOCUS_REFRESH_MIN_INTERVAL_MS) return;
        void refresh();
      }, 400);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer) window.clearTimeout(timer);
    };
  }, [refresh, probeGraph, enabled]);

  useEffect(() => {
    if (!enabled) return;
    return subscribeTerminalCommandFinished((cwd) => {
      const currentRepoRoot = stateRef.current.repo?.repoRoot;
      if (
        currentRepoRoot &&
        isPathInsideRepository(cwd, currentRepoRoot, workspaceEnv)
      ) {
        void probeGraph();
      }
    });
  }, [enabled, probeGraph, workspaceEnv]);

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        void refresh();
      }, 120);
    };
    const windowHandle = getCurrentWebviewWindow();
    const written = windowHandle.listen("fs:file-written", schedule);
    const changed = windowHandle.listen("fs:changed", schedule);
    return () => {
      window.clearTimeout(timer);
      void written.then((unlisten) => unlisten());
      void changed.then((unlisten) => unlisten());
    };
  }, [enabled, refresh]);

  return useMemo<RepositoryController>(
    () => ({
      repo: state.repo,
      status: state.status,
      diffStats: state.diffStats,
      changedCount: state.status?.changedFiles.length ?? 0,
      upstream: state.status?.upstream ?? state.repo?.upstream ?? null,
      ahead: state.status?.ahead ?? 0,
      behind: state.status?.behind ?? 0,
      hasRepo: state.repo !== null,
      isLoading: state.isLoading,
      localError: state.localError,
      busyAction: state.busyAction,
      lastRemoteError: state.lastRemoteError,
      revision: state.revision,
      graphRevision: state.graphRevision,
      refresh,
      runRemoteAction,
    }),
    [state, refresh, runRemoteAction],
  );
}
