/**
 * 本文件实现源代码管理面板的派生视图状态与用户操作。
 * 仓库数据只来自 Repository Controller，所有修改完成后重新读取真实 Git 状态。
 */

import {
  modelSupportsTemperature,
  providerNeedsKey,
  resolveModel,
} from "@/modules/ai/config";
import {
  type GitChangedFile,
  type GitDiscardEntry,
  type GitRepoInfo,
  type GitStatusSnapshot,
  native,
} from "@/modules/ai/lib/native";
import {
  selectActiveAgentMeta,
  useChatStore,
} from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useCallback, useMemo, useState } from "react";
import type { GitDiffSide } from "./gitTypes";
import { openSourceControlFileDiff } from "./openFileDiff";
import type { RepositoryController } from "./useRepositoryController";

type PanelState = "closed" | "loading" | "no-repo" | "ready" | "error";

const COMMIT_DIFF_CHAR_LIMIT = 60_000;
const COMMIT_MESSAGE_MAX_OUTPUT_TOKENS = 1024;
const CONVENTIONAL_PREFIX =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?: .+/;
const COMMIT_MESSAGE_SYSTEM_PROMPT =
  "You write concise Conventional Commit subject lines in English. Return exactly one complete line, with no markdown, no quotes, no body, and no explanation.";

type SourceControlEntry = {
  path: string;
  statusCode: string;
  originalPath: string | null;
  untracked: boolean;
};

/** 文件暂存复选框的三态值。 */
export type CheckState = "checked" | "indeterminate" | "unchecked";

/** 合并暂存与未暂存状态后的单个文件行。 */
export type SourceControlFileEntry = {
  key: string;
  path: string;
  originalPath: string | null;
  statusCode: string;
  statusLabel: string;
  checkState: CheckState;
  staged: boolean;
  unstaged: boolean;
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
  commitMessage: string;
  actionBusy: string | null;
  statusError: string | null;
  actionError: string | null;
  remoteError: string | null;
  actionMessage: string | null;
  stagedEntries: SourceControlEntry[];
  unstagedEntries: SourceControlEntry[];
  fileEntries: SourceControlFileEntry[];
  headerCheckState: CheckState;
  allClean: boolean;
  canPush: boolean;
  pushHint: string | null;
  canGenerateCommitMessage: boolean;
  generateCommitMessageHint: string;
  stagedEmptyText: string;
  unstagedEmptyText: string;
  pendingDiscard: PendingDiscard | null;
  setCommitMessage: (value: string) => void;
  refresh: () => Promise<void>;
  openFileDiff: (entry: SourceControlFileEntry) => void;
  toggleStageFile: (entry: SourceControlFileEntry) => Promise<void>;
  toggleAll: () => Promise<void>;
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
): SourceControlEntry {
  return {
    path: file.path,
    statusCode: statusCodeForSide(side, file),
    originalPath: file.originalPath,
    untracked: file.untracked,
  };
}

function stagedFilesSummary(entries: SourceControlEntry[]): string {
  return entries
    .map((entry) => {
      const status = entry.originalPath
        ? `R ${entry.originalPath} -> ${entry.path}`
        : `${entry.statusCode} ${entry.path}`;
      return `- ${status}`;
    })
    .join("\n");
}

function truncateDiff(diff: string): { text: string; truncated: boolean } {
  if (diff.length <= COMMIT_DIFF_CHAR_LIMIT) {
    return { text: diff, truncated: false };
  }
  return { text: diff.slice(0, COMMIT_DIFF_CHAR_LIMIT), truncated: true };
}

function cleanCommitMessage(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  if (fence) text = fence[1].trim();
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "";
  return firstLine.replace(/^["'`]+|["'`]+$/g, "").trim();
}

function isValidCommitMessage(message: string): boolean {
  return CONVENTIONAL_PREFIX.test(message);
}

function buildCommitMessagePrompt(
  entries: SourceControlEntry[],
  diffText: string,
  truncated: boolean,
): string {
  return [
    "Generate one complete commit message for the staged changes only.",
    "Format: type(scope): subject",
    "Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.",
    "Examples:",
    "- feat(source-control): generate commit messages",
    "- fix(git): handle staged diff errors",
    "- chore: update project metadata",
    "Use a short lowercase subject in imperative mood. Omit the scope if it would be vague.",
    "Do not stop after the type or an opening parenthesis; the line must include a subject after ': '.",
    truncated
      ? "The diff below was truncated; infer from the visible staged changes only."
      : "The full staged diff is included below.",
    "",
    "Staged files:",
    stagedFilesSummary(entries),
    "",
    "Staged diff:",
    diffText || "(No textual diff available.)",
  ].join("\n");
}

function buildRepairCommitMessagePrompt(
  invalidMessage: string,
  entries: SourceControlEntry[],
): string {
  return [
    "Repair this invalid Conventional Commit subject line.",
    `Invalid line: ${invalidMessage || "(empty)"}`,
    "Return exactly one complete valid line in this format: type(scope): subject",
    "Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.",
    "If the scope is unclear, omit it and use: type: subject",
    "",
    "Staged files:",
    stagedFilesSummary(entries),
  ].join("\n");
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
  const selectedModelId = useChatStore((state) => state.selectedModelId);
  const agentStatus = useChatStore(selectActiveAgentMeta).status;
  const hasApiKeyForSelected = useChatStore((state) => {
    const model = resolveModel(state.selectedModelId);
    return !providerNeedsKey(model.provider) || !!state.apiKeys[model.provider];
  });
  const lmstudioModelId = usePreferencesStore((state) => state.lmstudioModelId);
  const mlxModelId = usePreferencesStore((state) => state.mlxModelId);
  const ollamaModelId = usePreferencesStore((state) => state.ollamaModelId);
  const openaiCompatibleBaseURL = usePreferencesStore(
    (state) => state.openaiCompatibleBaseURL,
  );
  const openaiCompatibleModelId = usePreferencesStore(
    (state) => state.openaiCompatibleModelId,
  );
  const openrouterModelId = usePreferencesStore(
    (state) => state.openrouterModelId,
  );
  const repo = controller.repo;
  const status = controller.status;
  const panelState: PanelState = !isOpen
    ? "closed"
    : controller.localError && !status
      ? "error"
      : controller.isLoading && !status
        ? "loading"
        : repo && status
          ? "ready"
          : "no-repo";
  const [commitMessage, setCommitMessage] = useState("");
  const [localActionBusy, setLocalActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<
    | { scope: "single"; entry: SourceControlEntry }
    | { scope: "all"; entries: SourceControlEntry[] }
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

  const fileEntries = useMemo<SourceControlFileEntry[]>(() => {
    const seen = new Set<string>();
    const out: SourceControlFileEntry[] = [];
    for (const file of status?.changedFiles ?? []) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      const checkState: CheckState =
        file.staged && file.unstaged
          ? "indeterminate"
          : file.staged
            ? "checked"
            : "unchecked";
      const statusCode = file.unstaged
        ? statusCodeForSide("worktree", file)
        : statusCodeForSide("index", file);
      out.push({
        key: file.path,
        path: file.path,
        originalPath: file.originalPath,
        statusCode,
        statusLabel: file.statusLabel,
        checkState,
        staged: file.staged,
        unstaged: file.unstaged,
        untracked: file.untracked,
      });
    }
    return out;
  }, [status]);

  const headerCheckState = useMemo<CheckState>(() => {
    if (fileEntries.length === 0) return "unchecked";
    const allChecked = fileEntries.every((e) => e.checkState === "checked");
    if (allChecked) return "checked";
    const anyStaged = fileEntries.some((e) => e.staged);
    return anyStaged ? "indeterminate" : "unchecked";
  }, [fileEntries]);

  const allClean = stagedEntries.length === 0 && unstagedEntries.length === 0;
  const canPush = !!status?.upstream && status.behind === 0;
  const selectedModel = resolveModel(selectedModelId);
  const selectedModelSupportsTemperature = modelSupportsTemperature(
    selectedModel.provider,
    selectedModel.id,
  );
  const aiBusy = agentStatus !== "idle" && agentStatus !== "error";
  const anyActionBusy =
    localActionBusy !== null || controller.busyAction !== null;
  const aiUnavailableReason = useMemo(() => {
    if (stagedEntries.length === 0) {
      return "Stage changes to generate a commit message";
    }
    if (!hasApiKeyForSelected) {
      return "Connect an AI provider to generate commit messages";
    }
    if (selectedModel.id === "lmstudio-local" && !lmstudioModelId.trim()) {
      return "Connect an AI provider to generate commit messages";
    }
    if (selectedModel.id === "mlx-local" && !mlxModelId.trim()) {
      return "Connect an AI provider to generate commit messages";
    }
    if (selectedModel.id === "ollama-local" && !ollamaModelId.trim()) {
      return "Connect an AI provider to generate commit messages";
    }
    if (
      selectedModel.id === "openai-compatible-custom" &&
      (!openaiCompatibleBaseURL.trim() || !openaiCompatibleModelId.trim())
    ) {
      return "Connect an AI provider to generate commit messages";
    }
    if (selectedModel.id === "openrouter-custom" && !openrouterModelId.trim()) {
      return "Connect an AI provider to generate commit messages";
    }
    return null;
  }, [
    hasApiKeyForSelected,
    lmstudioModelId,
    mlxModelId,
    ollamaModelId,
    openaiCompatibleBaseURL,
    openaiCompatibleModelId,
    openrouterModelId,
    selectedModel,
    stagedEntries.length,
  ]);
  const canGenerateCommitMessage =
    stagedEntries.length > 0 && !anyActionBusy && !aiBusy && !!repo;
  const generateCommitMessageHint = aiUnavailableReason
    ? aiUnavailableReason
    : aiBusy
      ? "Wait for the current AI action to finish"
      : "Generate commit message";
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
  const stagedEmptyText = "No staged changes";
  const unstagedEmptyText = "No unstaged changes";

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
    const paths = stagedEntries.map((entry) => entry.path);
    await runMutation("unstage:all", () =>
      native.gitUnstage(repo.repoRoot, paths),
    );
  }, [repo, runMutation, stagedEntries]);

  const openFileDiff = useCallback(
    (entry: SourceControlFileEntry) => {
      if (!repo) return;
      setActionError(null);
      setActionMessage(null);
      if (onOpenDiff) {
        openSourceControlFileDiff(repo.repoRoot, entry, onOpenDiff);
      }
      void controller.refresh();
    },
    [controller, onOpenDiff, repo],
  );

  const toggleStageFile = useCallback(
    async (entry: SourceControlFileEntry) => {
      if (!repo) return;
      if (entry.checkState === "checked") {
        await runMutation(`unstage:${entry.path}`, () =>
          native.gitUnstage(repo.repoRoot, [entry.path]),
        );
      } else {
        await runMutation(`stage:${entry.path}`, () =>
          native.gitStage(repo.repoRoot, [entry.path]),
        );
      }
    },
    [repo, runMutation],
  );

  const toggleAll = useCallback(async () => {
    if (headerCheckState === "checked") await unstageAllEntries();
    else await stageAllEntries();
  }, [headerCheckState, stageAllEntries, unstageAllEntries]);

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
    if (!repo || stagedEntries.length === 0) return;
    if (aiBusy) {
      setActionError("Wait for the current AI action to finish");
      return;
    }
    if (aiUnavailableReason) {
      setActionError(aiUnavailableReason);
      return;
    }
    setLocalActionBusy("generate-message");
    setActionMessage(null);
    setActionError(null);
    try {
      const [{ buildConfiguredLanguageModel }, { generateText }, diff] =
        await Promise.all([
          import("@/modules/ai/lib/agent"),
          import("ai"),
          native.gitDiff(repo.repoRoot, null, "index"),
        ]);
      const { text: diffText, truncated } = truncateDiff(diff.diffText);
      const chatState = useChatStore.getState();
      const prefs = usePreferencesStore.getState();
      const model = await buildConfiguredLanguageModel(
        selectedModelId,
        chatState.apiKeys,
        {
          lmstudioBaseURL: prefs.lmstudioBaseURL,
          lmstudioModelId,
          mlxBaseURL: prefs.mlxBaseURL,
          mlxModelId,
          ollamaBaseURL: prefs.ollamaBaseURL,
          ollamaModelId,
          openaiCompatibleBaseURL,
          openaiCompatibleModelId,
          openrouterModelId,
        },
      );
      const result = await generateText({
        model,
        system: COMMIT_MESSAGE_SYSTEM_PROMPT,
        prompt: buildCommitMessagePrompt(stagedEntries, diffText, truncated),
        maxOutputTokens: COMMIT_MESSAGE_MAX_OUTPUT_TOKENS,
        ...(selectedModelSupportsTemperature ? { temperature: 0.2 } : {}),
      });
      let message = cleanCommitMessage(result.text);
      if (!isValidCommitMessage(message)) {
        const repair = await generateText({
          model,
          system: COMMIT_MESSAGE_SYSTEM_PROMPT,
          prompt: buildRepairCommitMessagePrompt(message, stagedEntries),
          maxOutputTokens: COMMIT_MESSAGE_MAX_OUTPUT_TOKENS,
          ...(selectedModelSupportsTemperature ? { temperature: 0 } : {}),
        });
        message = cleanCommitMessage(repair.text);
      }
      if (!isValidCommitMessage(message)) {
        throw new Error(
          "AI returned an invalid commit message. Try again or switch models.",
        );
      }
      setCommitMessage(message);
      setActionMessage(null);
    } catch (error) {
      setActionError(normalizeError(error));
    } finally {
      setLocalActionBusy(null);
    }
  }, [
    aiUnavailableReason,
    aiBusy,
    lmstudioModelId,
    mlxModelId,
    ollamaModelId,
    openaiCompatibleBaseURL,
    openaiCompatibleModelId,
    openrouterModelId,
    repo,
    selectedModelId,
    selectedModelSupportsTemperature,
    stagedEntries,
  ]);

  const commit = useCallback(async () => {
    if (!repo || controller.busyAction) return;
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
  }, [commitMessage, controller, repo]);

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
    repo,
    status,
    commitMessage,
    actionBusy: localActionBusy ?? controller.busyAction,
    statusError: controller.localError,
    actionError,
    remoteError: controller.lastRemoteError,
    actionMessage,
    stagedEntries,
    unstagedEntries,
    fileEntries,
    headerCheckState,
    allClean,
    canPush,
    pushHint,
    canGenerateCommitMessage,
    generateCommitMessageHint,
    stagedEmptyText,
    unstagedEmptyText,
    pendingDiscard: pendingDiscardView,
    setCommitMessage,
    refresh,
    openFileDiff,
    toggleStageFile,
    toggleAll,
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
