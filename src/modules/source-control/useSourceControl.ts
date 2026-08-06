/**
 * 本文件维护当前仓库唯一的 Source Control 状态模型。
 * 所有调用方共享原生快照，仓库修改和文件事件只触发合并后的真实状态刷新。
 */

import {
  type GitRepoInfo,
  type GitStatusSnapshot,
  native,
} from "@/modules/ai/lib/native";
import { useWorkspaceEnvStore, workspaceScopeKey } from "@/modules/workspace";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  notifyRepositoryChanged,
  notifyRepositoryHeadChanged,
} from "./repositoryChanges";
import {
  createRepositoryRefreshQueue,
  type RepositoryRefreshMode,
} from "./repositoryRefresh";

const AUTO_FETCH_THROTTLE_MS = 5 * 60_000;
const AUTO_FETCH_LRU_LIMIT = 16;
const FOCUS_REFRESH_MIN_INTERVAL_MS = 1500;
// Skip the context-change refetch when the data is this fresh and the new path
// is still inside the loaded repo (cd-within-repo produces identical status).
const SC_STATUS_TTL_MS = 2000;

export type SourceControlRefreshMode = RepositoryRefreshMode;
export type SourceControlRemoteAction = "fetch" | "pull" | "push";
export type SourceControlRemoteActionMode =
  | "contextual"
  | SourceControlRemoteAction;

export type SourceControlRemoteActionResult = {
  ok: boolean;
  action: SourceControlRemoteAction | null;
  error?: string;
  blocked?: "diverged" | "missing-upstream" | "no-repo";
};

export type SourceControlSummary = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  changedCount: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRepo: boolean;
  isLoading: boolean;
  localError: string | null;
  busyAction: SourceControlRemoteAction | null;
  lastRemoteError: string | null;
  refresh: (options?: { remote?: SourceControlRefreshMode }) => Promise<void>;
  runRemoteAction: (
    mode?: SourceControlRemoteActionMode,
  ) => Promise<SourceControlRemoteActionResult>;
};

export type SourceControlRemoteIndicator = {
  visible: boolean;
  label: string;
  title: string;
  disabled: boolean;
  action: SourceControlRemoteAction | null;
};

type SourceControlSummaryState = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  hasRepo: boolean;
  isLoading: boolean;
  localError: string | null;
  busyAction: SourceControlRemoteAction | null;
  lastRemoteError: string | null;
};

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
): SourceControlRemoteAction | null {
  if (!status?.upstream) return null;
  if (status.ahead > 0 && status.behind > 0) return null;
  if (status.behind > 0) return "pull";
  if (status.ahead > 0) return "push";
  return "fetch";
}

function statusFingerprint(status: GitStatusSnapshot | null): string {
  if (!status) return "";
  return JSON.stringify([
    status.headSha,
    status.branch,
    status.upstream,
    status.ahead,
    status.behind,
    status.changedFiles.map((file) => [
      file.path,
      file.originalPath,
      file.indexStatus,
      file.worktreeStatus,
    ]),
  ]);
}

export function getSourceControlRemoteIndicator(
  summary: Pick<
    SourceControlSummary,
    "hasRepo" | "upstream" | "ahead" | "behind" | "busyAction"
  >,
): SourceControlRemoteIndicator {
  if (!summary.hasRepo || !summary.upstream) {
    return {
      visible: false,
      label: "",
      title: "",
      disabled: true,
      action: null,
    };
  }
  if (summary.ahead > 0 && summary.behind > 0) {
    return {
      visible: true,
      label: `↑${summary.ahead} ↓${summary.behind}`,
      title:
        "Branch has diverged from upstream. Use Source Control or the terminal to resolve it.",
      disabled: true,
      action: null,
    };
  }
  if (summary.behind > 0) {
    return {
      visible: true,
      label: `↓${summary.behind}`,
      title: `Pull ${summary.behind} remote ${
        summary.behind === 1 ? "commit" : "commits"
      } with fast-forward only.`,
      disabled: summary.busyAction !== null,
      action: "pull",
    };
  }
  if (summary.ahead > 0) {
    return {
      visible: true,
      label: `↑${summary.ahead}`,
      title: `Push ${summary.ahead} local ${
        summary.ahead === 1 ? "commit" : "commits"
      }.`,
      disabled: summary.busyAction !== null,
      action: "push",
    };
  }
  return {
    visible: true,
    label: "Sync",
    title: "Fetch remote updates.",
    disabled: summary.busyAction !== null,
    action: "fetch",
  };
}

function touchAutoFetch(map: Map<string, number>, key: string): void {
  map.delete(key);
  map.set(key, Date.now());
  while (map.size > AUTO_FETCH_LRU_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * 维护当前工作区上下文对应的唯一 Git 仓库快照。
 *
 * 本地事件和 Git 操作共用串行刷新队列；刷新期间发生的新失效会在当前请求结束后再次读取真实状态。
 */
export function useSourceControl(
  contextPath: string | null,
  enabled: boolean = true,
): SourceControlSummary {
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const workspaceKey = workspaceScopeKey(workspaceEnv);
  const [state, setState] = useState<SourceControlSummaryState>({
    repo: null,
    status: null,
    hasRepo: false,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
  });
  const stateRef = useRef(state);
  const requestIdRef = useRef(0);
  const doRefreshRef = useRef<
    ((mode: SourceControlRefreshMode) => Promise<void>) | null
  >(null);
  const refreshQueueRef = useRef<ReturnType<
    typeof createRepositoryRefreshQueue
  > | null>(null);
  if (!refreshQueueRef.current) {
    refreshQueueRef.current = createRepositoryRefreshQueue(async (mode) => {
      await doRefreshRef.current?.(mode);
    });
  }
  const autoFetchByRepoRef = useRef(new Map<string, number>());
  const enabledRef = useRef(enabled);
  const lastRefreshAtRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    void workspaceKey;
    requestIdRef.current++;
    autoFetchByRepoRef.current.clear();
    setState({
      repo: null,
      status: null,
      hasRepo: false,
      isLoading: false,
      localError: null,
      busyAction: null,
      lastRemoteError: null,
    });
  }, [workspaceKey]);

  const doRefresh = useCallback(
    async (remoteMode: SourceControlRefreshMode): Promise<void> => {
      void workspaceKey;
      if (!enabledRef.current) return;
      const requestId = ++requestIdRef.current;

      if (!contextPath) {
        setState({
          repo: null,
          status: null,
          hasRepo: false,
          isLoading: false,
          localError: null,
          busyAction: null,
          lastRemoteError: null,
        });
        return;
      }

      const activeRoot = stateRef.current.repo?.repoRoot ?? null;
      const reusableRoot =
        activeRoot &&
        (contextPath === activeRoot || contextPath.startsWith(`${activeRoot}/`))
          ? activeRoot
          : undefined;

      setState((current) => ({
        ...current,
        isLoading: true,
        localError: null,
      }));

      try {
        let repo: GitRepoInfo | null;
        let status: GitStatusSnapshot | null;

        if (reusableRoot) {
          try {
            repo = stateRef.current.repo ?? null;
            status = await native.gitStatus(reusableRoot);
            if (requestId !== requestIdRef.current) return;
            if (!repo || repo.repoRoot !== reusableRoot) {
              repo = {
                repoRoot: reusableRoot,
                branch: status.branch,
                upstream: status.upstream,
                isDetached: status.isDetached,
              };
            }
          } catch {
            const snapshot = await native.gitPanelSnapshot(contextPath);
            if (requestId !== requestIdRef.current) return;
            if (!snapshot.repo) {
              setState((current) => ({
                ...current,
                repo: null,
                status: null,
                hasRepo: false,
                isLoading: false,
                localError: null,
              }));
              return;
            }
            repo = snapshot.repo;
            status = snapshot.status ?? null;
          }
        } else {
          const snapshot = await native.gitPanelSnapshot(contextPath);
          if (requestId !== requestIdRef.current) return;
          if (!snapshot.repo) {
            setState((current) => ({
              ...current,
              repo: null,
              status: null,
              hasRepo: false,
              isLoading: false,
              localError: null,
            }));
            return;
          }
          repo = snapshot.repo;
          status = snapshot.status ?? null;
        }

        if (!repo) {
          setState((current) => ({
            ...current,
            repo: null,
            status: null,
            hasRepo: false,
            isLoading: false,
            localError: null,
          }));
          return;
        }

        let nextRemoteError = stateRef.current.lastRemoteError;
        const shouldAutoFetch =
          repo.upstream &&
          remoteMode !== "never" &&
          (remoteMode === "always" ||
            Date.now() - (autoFetchByRepoRef.current.get(repo.repoRoot) ?? 0) >=
              AUTO_FETCH_THROTTLE_MS);

        if (shouldAutoFetch) {
          try {
            await native.gitFetch(repo.repoRoot);
            touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
            nextRemoteError = null;
            if (requestId !== requestIdRef.current) return;
            status = await native.gitStatus(repo.repoRoot);
            if (requestId !== requestIdRef.current) return;
          } catch (error) {
            nextRemoteError = normalizeError(error);
          }
        }

        const previousStatus =
          stateRef.current.status?.repoRoot === repo.repoRoot
            ? stateRef.current.status
            : null;
        if (statusFingerprint(previousStatus) !== statusFingerprint(status)) {
          notifyRepositoryChanged(repo.repoRoot);
        }
        if (previousStatus?.headSha !== status?.headSha) {
          notifyRepositoryHeadChanged(repo.repoRoot, status?.headSha ?? null);
        }
        setState((current) => ({
          ...current,
          repo,
          status,
          hasRepo: true,
          isLoading: false,
          localError: null,
          lastRemoteError: nextRemoteError,
        }));
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        setState((current) => ({
          ...current,
          repo: null,
          hasRepo: false,
          status: null,
          isLoading: false,
          localError: normalizeError(error),
        }));
      } finally {
        lastRefreshAtRef.current = Date.now();
      }
    },
    [contextPath, workspaceKey],
  );
  doRefreshRef.current = doRefresh;

  const refresh = useCallback(
    (options?: { remote?: SourceControlRefreshMode }) => {
      const remoteMode = options?.remote ?? "never";
      return refreshQueueRef.current?.request(remoteMode) ?? Promise.resolve();
    },
    [],
  );

  const runRemoteAction = useCallback(
    async (
      mode: SourceControlRemoteActionMode = "contextual",
    ): Promise<SourceControlRemoteActionResult> => {
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

      setState((current) => ({ ...current, busyAction: action }));

      try {
        if (action === "fetch") {
          await native.gitFetch(repo.repoRoot);
          touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
        } else if (action === "pull") {
          await native.gitFetch(repo.repoRoot);
          touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
          await native.gitPullFfOnly(repo.repoRoot);
        } else {
          await native.gitPush(repo.repoRoot);
        }
        setState((current) => ({ ...current, lastRemoteError: null }));
        await refresh({ remote: "never" });
        return { ok: true, action };
      } catch (error) {
        const message = normalizeError(error);
        setState((current) => ({ ...current, lastRemoteError: message }));
        await refresh({ remote: "never" }).catch(() => {});
        return { ok: false, action, error: message };
      } finally {
        setState((current) => ({ ...current, busyAction: null }));
      }
    },
    [refresh],
  );

  useEffect(() => {
    void workspaceKey;
    if (!enabled) {
      requestIdRef.current++;
      setState({
        repo: null,
        status: null,
        hasRepo: false,
        isLoading: false,
        localError: null,
        busyAction: null,
        lastRemoteError: null,
      });
      return;
    }
    setState((current) => ({ ...current, lastRemoteError: null }));
    const run = () => {
      const root = stateRef.current.repo?.repoRoot;
      const sameRepo =
        !!root &&
        !!contextPath &&
        (contextPath === root || contextPath.startsWith(`${root}/`));
      const fresh = Date.now() - lastRefreshAtRef.current < SC_STATUS_TTL_MS;
      if (fresh && sameRepo && stateRef.current.hasRepo) return;
      void refresh({ remote: "never" });
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
          /* noop */
        }
      } else {
        window.clearTimeout(idle as number);
      }
    };
  }, [refresh, contextPath, enabled, workspaceKey]);

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const onFocus = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        const elapsed = Date.now() - lastRefreshAtRef.current;
        if (elapsed < FOCUS_REFRESH_MIN_INTERVAL_MS) return;
        void refresh({ remote: "never" });
      }, 400);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer) window.clearTimeout(timer);
    };
  }, [refresh, enabled]);

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        void refresh({ remote: "never" });
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

  return useMemo<SourceControlSummary>(
    () => ({
      repo: state.repo,
      status: state.status,
      changedCount: state.status?.changedFiles.length ?? 0,
      upstream: state.status?.upstream ?? state.repo?.upstream ?? null,
      ahead: state.status?.ahead ?? 0,
      behind: state.status?.behind ?? 0,
      hasRepo: state.hasRepo,
      isLoading: state.isLoading,
      localError: state.localError,
      busyAction: state.busyAction,
      lastRemoteError: state.lastRemoteError,
      refresh,
      runRemoteAction,
    }),
    [state, refresh, runRemoteAction],
  );
}
