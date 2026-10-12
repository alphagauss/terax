/**
 * 本文件实现源代码管理面板的派生视图状态与用户操作。
 * 仓库数据只来自 Repository Controller，所有修改完成后重新读取真实 Git 状态。
 */

import {
  isModelRefAvailable,
  resolveProviderInstance,
  tryResolveModel,
} from "@/modules/ai/config";
import { resolveModelUsage } from "@/modules/ai/lib/modelUsage";
import {
  type GitChangedFile,
  type GitDiscardEntry,
  type GitFileLineStats,
  type GitPanelDiffStats,
  type GitRepoInfo,
  type GitStatusSnapshot,
  native,
} from "@/modules/ai/lib/native";
import { isProviderConnectionReady } from "@/modules/ai/providerRegistry";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type CommitMessageEntry,
  commitMessageStore,
  EMPTY_COMMIT_MESSAGE,
  generateRepositoryCommitMessage,
  setCommitMessageDraft,
} from "@/modules/source-control/commitMessage";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { GitDiffSide } from "./gitTypes";
import type { RepositoryController } from "./useRepositoryController";

type PanelState = "loading" | "no-repo" | "ready" | "error";

/** 按差异侧独立展示的文件行；部分暂存文件在两组各有一行。 */
export type SourceControlFileEntry = {
  key: string;
  path: string;
  originalPath: string | null;
  statusCode: string;
  side: GitDiffSide;
  lineStats: GitFileLineStats | null;
  canOpenFile: boolean;
  untracked: boolean;
};

/** 丢弃确认框展示的目标范围。 */
type PendingDiscard = {
  scope: "single" | "all";
  count: number;
  label: string;
};

type SourceControlPanelState = {
  panelState: PanelState;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  diffStats: GitPanelDiffStats | null;
  commitMessage: string;
  actionBusy: string | null;
  statusError: string | null;
  actionError: string | null;
  remoteError: string | null;
  actionMessage: string | null;
  stagedEntries: CommitMessageEntry[];
  unstagedEntries: CommitMessageEntry[];
  fileEntries: SourceControlFileEntry[];
  allClean: boolean;
  canPush: boolean;
  pushHint: string | null;
  canGenerateCommitMessage: boolean;
  generateCommitMessageHint: string;
  pendingDiscard: PendingDiscard | null;
  setCommitMessage: (value: string) => void;
  refresh: () => Promise<void>;
  openFileDiff: (entry: SourceControlFileEntry) => void;
  toggleStageFile: (entry: SourceControlFileEntry) => Promise<void>;
  requestDiscardFile: (entry: SourceControlFileEntry) => void;
  requestDiscardAll: () => void;
  confirmPendingDiscard: () => Promise<void>;
  cancelPendingDiscard: () => void;
  stageAllEntries: () => Promise<void>;
  unstageAllEntries: () => Promise<void>;
  generateCommitMessage: () => Promise<void>;
  commit: () => Promise<void>;
  push: () => Promise<void>;
};

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown source control error";
}

function normalizeStatusCode(status: string): string {
  const code = status.trim().toUpperCase();
  switch (code) {
    case "?":
      return "U";
    case "A":
      return "A";
    case "M":
      return "M";
    case "D":
      return "D";
    case "R":
    case "C":
      return "R";
    case "U":
      return "U";
    default:
      return code || "M";
  }
}

function statusCodeForSide(side: GitDiffSide, file: GitChangedFile): string {
  if (side === "worktree" && file.untracked) return "U";
  const primary = side === "index" ? file.indexStatus : file.worktreeStatus;
  const fallback = side === "index" ? file.worktreeStatus : file.indexStatus;
  return normalizeStatusCode(primary !== " " ? primary : fallback);
}

function makeEntry(
  file: GitChangedFile,
  side: GitDiffSide,
): CommitMessageEntry {
  return {
    path: file.path,
    statusCode: statusCodeForSide(side, file),
    originalPath: file.originalPath,
    untracked: file.untracked,
  };
}

/** 重命名的取消暂存必须同时恢复旧、新路径，不能留下旧路径的暂存删除。 */
function unstagePaths(files: GitChangedFile[]): string[] {
  return [
    ...new Set(
      files.flatMap((file) =>
        file.indexStatus === "R" && file.originalPath
          ? [file.path, file.originalPath]
          : [file.path],
      ),
    ),
  ];
}

/**
 * 从唯一仓库快照派生 Source Control 面板状态，并执行用户触发的 Git 操作。
 * 所有 mutation 完成后通过共享刷新入口读取真实状态，不维护乐观副本。
 */
export function useSourceControlPanel(
  isOpen: boolean,
  controller: RepositoryController,
  onOpenDiff:
    | ((input: {
        path: string;
        repoRoot: string;
        side: GitDiffSide;
        originalPath: string | null;
        title?: string;
      }) => void)
    | null,
): SourceControlPanelState {
  const { t } = useTranslation("sourceControl");
  const selectedModelRef = usePreferencesStore(
    (state) => state.modelUsages.commitMessage.model ?? state.defaultModel,
  );
  const providerModels = usePreferencesStore((state) => state.providerModels);
  const customProviders = usePreferencesStore((state) => state.customProviders);
  const providerBaseURLs = usePreferencesStore(
    (state) => state.providerBaseURLs,
  );
  const apiKeys = useChatStore((state) => state.apiKeys);
  const providerInstanceKeys = useChatStore(
    (state) => state.providerInstanceKeys,
  );
  const repo = controller.repo;
  const status = controller.status;
  // 可见性不改变数据状态，避免普通侧栏切换卸载 Changes 滚动节点。
  const panelState: PanelState = controller.isLoading
    ? "loading"
    : controller.localError && !status
      ? "error"
      : repo && status
        ? "ready"
        : "no-repo";
  const messageState = useStore(commitMessageStore, (state) =>
    repo
      ? (state[repo.repoRoot] ?? EMPTY_COMMIT_MESSAGE)
      : EMPTY_COMMIT_MESSAGE,
  );
  const commitMessage = messageState.text;
  const setCommitMessage = useCallback(
    (text: string) => {
      if (repo) setCommitMessageDraft(repo.repoRoot, text);
    },
    [repo],
  );
  const [localActionBusy, setLocalActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<
    | { scope: "single"; entry: CommitMessageEntry }
    | { scope: "all"; entries: CommitMessageEntry[] }
    | null
  >(null);
  const stagedEntries = useMemo(
    () =>
      (status?.changedFiles ?? [])
        .filter((file) => file.staged)
        .map((file) => makeEntry(file, "index")),
    [status],
  );

  const unstagedEntries = useMemo(
    () =>
      (status?.changedFiles ?? [])
        .filter((file) => file.unstaged)
        .map((file) => makeEntry(file, "worktree")),
    [status],
  );

  const fileEntries = useMemo<SourceControlFileEntry[]>(
    () =>
      (["index", "worktree"] as const).flatMap((side) =>
        (status?.changedFiles ?? [])
          .filter((file) => (side === "index" ? file.staged : file.unstaged))
          .map((file) => ({
            ...makeEntry(file, side),
            key: `${side}:${file.path}`,
            side,
            canOpenFile:
              file.indexStatus !== "D" && file.worktreeStatus !== "D",
            lineStats: controller.diffStats?.[side]?.files[file.path] ?? null,
          })),
      ),
    [status, controller.diffStats],
  );

  const allClean = stagedEntries.length === 0 && unstagedEntries.length === 0;
  const canPush = !!status?.upstream && status.behind === 0;
  const selectedModel =
    selectedModelRef &&
    isModelRefAvailable(selectedModelRef, providerModels, {
      customProviders,
      providerBaseURLs,
    })
      ? tryResolveModel(selectedModelRef, {
          customProviders,
          providerBaseURLs,
        })
      : null;
  const providerReady = selectedModel
    ? isProviderConnectionReady(
        resolveProviderInstance(selectedModel.providerId, {
          customProviders,
          providerBaseURLs,
          providerCredentials: apiKeys,
          providerInstanceCredentials: providerInstanceKeys,
        }),
      )
    : false;
  const anyActionBusy =
    localActionBusy !== null ||
    controller.busyAction !== null ||
    messageState.running;
  const aiUnavailableReason = useMemo(() => {
    if (stagedEntries.length === 0) {
      return t("generation.stageFirst");
    }
    if (!selectedModel || !providerReady) {
      return t("generation.configureModel");
    }
    return null;
  }, [providerReady, selectedModel, stagedEntries.length, t]);
  const canGenerateCommitMessage =
    stagedEntries.length > 0 &&
    !anyActionBusy &&
    !aiUnavailableReason &&
    !!repo;
  const generateCommitMessageHint =
    aiUnavailableReason ?? t("generation.generate");
  const pushHint = useMemo(() => {
    if (!status) return null;
    if (!status.upstream) {
      return "Configure or publish this branch in the terminal to enable push in this iteration.";
    }
    if (status.behind > 0) {
      return "Pull remote changes before pushing local commits.";
    }
    if (status.ahead === 0) {
      return `No local commits to push to ${status.upstream}.`;
    }
    return `Pushes to ${status.upstream}.`;
  }, [status]);

  const refresh = useCallback(async () => {
    if (!isOpen) return;
    await controller.refresh();
  }, [controller, isOpen]);

  const runMutation = useCallback(
    async (busyKey: string, ipc: () => Promise<void>) => {
      if (!repo || controller.busyAction) return;
      setLocalActionBusy(busyKey);
      setActionMessage(null);
      setActionError(null);
      try {
        await ipc();
        await controller.refresh();
      } catch (error) {
        setActionError(normalizeError(error));
        await controller.refresh().catch(() => {});
      } finally {
        setLocalActionBusy(null);
      }
    },
    [controller, repo],
  );

  const requestDiscardAll = useCallback(() => {
    if (!repo || controller.busyAction || unstagedEntries.length === 0) return;
    setPendingDiscard({ scope: "all", entries: unstagedEntries });
  }, [controller.busyAction, repo, unstagedEntries]);

  const cancelPendingDiscard = useCallback(() => {
    setPendingDiscard(null);
  }, []);

  const confirmPendingDiscard = useCallback(async () => {
    if (!repo || !pendingDiscard) return;
    const list =
      pendingDiscard.scope === "single"
        ? [pendingDiscard.entry]
        : pendingDiscard.entries;
    setPendingDiscard(null);
    const entries: GitDiscardEntry[] = list.map((entry) => ({
      path: entry.path,
      untracked: entry.untracked,
    }));
    await runMutation(
      pendingDiscard.scope === "single"
        ? `discard:${list[0].path}`
        : "discard:all",
      () => native.gitDiscard(repo.repoRoot, entries),
    );
  }, [pendingDiscard, repo, runMutation]);

  const stageAllEntries = useCallback(async () => {
    if (!repo || unstagedEntries.length === 0) return;
    const paths = unstagedEntries.map((entry) => entry.path);
    await runMutation("stage:all", () => native.gitStage(repo.repoRoot, paths));
  }, [repo, runMutation, unstagedEntries]);

  const unstageAllEntries = useCallback(async () => {
    if (!repo || stagedEntries.length === 0) return;
    const paths = unstagePaths(
      (status?.changedFiles ?? []).filter((file) => file.staged),
    );
    await runMutation("unstage:all", () =>
      native.gitUnstage(repo.repoRoot, paths),
    );
  }, [repo, runMutation, stagedEntries, status]);

  const openFileDiff = useCallback(
    (entry: SourceControlFileEntry) => {
      if (!repo) return;
      setActionError(null);
      setActionMessage(null);
      if (onOpenDiff) {
        onOpenDiff({
          repoRoot: repo.repoRoot,
          path: entry.path,
          side: entry.side,
          originalPath: entry.originalPath,
        });
      }
      void controller.refresh();
    },
    [controller, onOpenDiff, repo],
  );

  const toggleStageFile = useCallback(
    async (entry: SourceControlFileEntry) => {
      if (!repo) return;
      if (entry.side === "index") {
        await runMutation(`unstage:${entry.path}`, () =>
          native.gitUnstage(
            repo.repoRoot,
            unstagePaths(
              (status?.changedFiles ?? []).filter(
                (file) => file.staged && file.path === entry.path,
              ),
            ),
          ),
        );
      } else {
        await runMutation(`stage:${entry.path}`, () =>
          native.gitStage(repo.repoRoot, [entry.path]),
        );
      }
    },
    [repo, runMutation, status],
  );

  const requestDiscardFile = useCallback(
    (entry: SourceControlFileEntry) => {
      if (!repo || controller.busyAction) return;
      setPendingDiscard({
        scope: "single",
        entry: {
          path: entry.path,
          statusCode: entry.statusCode,
          originalPath: entry.originalPath,
          untracked: entry.untracked,
        },
      });
    },
    [controller.busyAction, repo],
  );

  const generateCommitMessage = useCallback(async () => {
    if (!repo || !stagedEntries.length || anyActionBusy) return;
    const prefs = usePreferencesStore.getState();
    const config = resolveModelUsage(
      prefs.modelUsages.commitMessage,
      prefs.modelParameters,
      prefs.defaultModel,
    );
    if (
      !config ||
      !isModelRefAvailable(config.model, prefs.providerModels, prefs)
    ) {
      setActionError(t("generation.configureModel"));
      return;
    }
    const keys = useChatStore.getState();
    const connection = resolveProviderInstance(config.model.providerId, {
      customProviders: prefs.customProviders,
      providerBaseURLs: prefs.providerBaseURLs,
      providerCredentials: keys.apiKeys,
      providerInstanceCredentials: keys.providerInstanceKeys,
    });
    if (!isProviderConnectionReady(connection)) {
      setActionError(t("generation.configureModel"));
      return;
    }
    setActionMessage(null);
    setActionError(null);
    await generateRepositoryCommitMessage(repo.repoRoot, stagedEntries, {
      connection,
      modelId: config.model.modelId,
      parameters: config.parameters,
    });
  }, [anyActionBusy, repo, stagedEntries, t]);

  const commit = useCallback(async () => {
    if (!repo || controller.busyAction || messageState.running) return;
    setLocalActionBusy("commit");
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await native.gitCommit(repo.repoRoot, commitMessage);
      setCommitMessage("");
      setActionMessage(
        `Committed ${result.commitSha.slice(0, 7)} ${result.summary}`,
      );
      await controller.refresh();
    } catch (error) {
      setActionError(normalizeError(error));
    } finally {
      setLocalActionBusy(null);
    }
  }, [commitMessage, controller, repo, messageState.running, setCommitMessage]);

  const push = useCallback(async () => {
    if (!repo) return;
    setActionMessage(null);
    setActionError(null);
    const result = await controller.runRemoteAction("push");
    if (result.ok) {
      setActionMessage(
        status?.upstream ? `Pushed to ${status.upstream}` : "Push completed",
      );
      return;
    }
    if (result.error) {
      setActionError(result.error);
    }
  }, [controller, repo, status?.upstream]);

  const pendingDiscardView = useMemo<PendingDiscard | null>(() => {
    if (!pendingDiscard) return null;
    if (pendingDiscard.scope === "single") {
      return {
        scope: "single",
        count: 1,
        label: pendingDiscard.entry.path,
      };
    }
    return {
      scope: "all",
      count: pendingDiscard.entries.length,
      label: `${pendingDiscard.entries.length} unstaged ${
        pendingDiscard.entries.length === 1 ? "file" : "files"
      }`,
    };
  }, [pendingDiscard]);

  return {
    panelState,
    diffStats: controller.diffStats,
    repo,
    status,
    commitMessage,
    actionBusy: messageState.running
      ? "generate-message"
      : (localActionBusy ?? controller.busyAction),
    statusError: controller.localError,
    actionError:
      actionError ??
      (messageState.error?.kind === "invalid"
        ? t("generation.invalid")
        : (messageState.error?.message ?? null)),
    remoteError: controller.lastRemoteError,
    actionMessage,
    stagedEntries,
    unstagedEntries,
    fileEntries,
    allClean,
    canPush,
    pushHint,
    canGenerateCommitMessage,
    generateCommitMessageHint,
    pendingDiscard: pendingDiscardView,
    setCommitMessage,
    refresh,
    openFileDiff,
    toggleStageFile,
    requestDiscardFile,
    requestDiscardAll,
    confirmPendingDiscard,
    cancelPendingDiscard,
    stageAllEntries,
    unstageAllEntries,
    generateCommitMessage,
    commit,
    push,
  };
}
