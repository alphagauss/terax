/**
 * 本文件拥有提交信息生成任务和按仓库隔离的内存草稿。
 * 暂存区摘要、提示词和一次修复属于本模块；模型请求复用 AI 轻量任务服务。
 * UI 卸载不停止请求，晚到结果不覆盖任务开始后的手工输入。
 */
import { createStore } from "zustand/vanilla";
import { native } from "@/modules/ai/lib/native";
import {
  createTextGenerationTask,
  type TextGenerationConfiguration,
} from "@/modules/ai/lib/textGeneration";

const COMMIT_DIFF_CHAR_LIMIT = 60_000;
const CONVENTIONAL_PREFIX =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?: .+/;
const COMMIT_MESSAGE_SYSTEM_PROMPT =
  "You write concise Conventional Commit subject lines in English. Return exactly one complete line, with no markdown, no quotes, no body, and no explanation.";

export type CommitMessageEntry = {
  path: string;
  statusCode: string;
  originalPath: string | null;
  untracked: boolean;
};

function stagedFilesSummary(entries: CommitMessageEntry[]): string {
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
  entries: CommitMessageEntry[],
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
  entries: CommitMessageEntry[],
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

export type CommitMessageState = {
  text: string;
  revision: number;
  running: boolean;
  error: { kind: "invalid" } | { kind: "request"; message: string } | null;
};
export const EMPTY_COMMIT_MESSAGE: CommitMessageState = {
  text: "",
  revision: 0,
  running: false,
  error: null,
};
export const commitMessageStore = createStore<
  Record<string, CommitMessageState>
>(() => ({}));

function current(repoRoot: string): CommitMessageState {
  return commitMessageStore.getState()[repoRoot] ?? EMPTY_COMMIT_MESSAGE;
}

function update(repoRoot: string, patch: Partial<CommitMessageState>) {
  commitMessageStore.setState({
    [repoRoot]: { ...current(repoRoot), ...patch },
  });
}

/** 用户编辑或提交后清空草稿会推进版本，使正在运行的旧结果不能覆盖它。 */
export function setCommitMessageDraft(repoRoot: string, text: string): void {
  update(repoRoot, {
    text,
    revision: current(repoRoot).revision + 1,
    error: null,
  });
}

/** 一次生成和至多一次修复共用同一模型配置；每个仓库最多一个生成任务。 */
export async function generateRepositoryCommitMessage(
  repoRoot: string,
  entries: readonly CommitMessageEntry[],
  configuration: TextGenerationConfiguration,
): Promise<void> {
  const state = current(repoRoot);
  if (state.running || !entries.length) return;
  const revision = state.revision;
  update(repoRoot, { running: true, error: null });
  try {
    const task = createTextGenerationTask(configuration);
    const staged = structuredClone([...entries]);
    const diff = await native.gitDiff(repoRoot, null, "index");
    const { text: diffText, truncated } = truncateDiff(diff.diffText);
    let message = cleanCommitMessage(
      await task.generate({
        instructions: COMMIT_MESSAGE_SYSTEM_PROMPT,
        prompt: buildCommitMessagePrompt(
          staged,
          diffText,
          truncated || diff.truncated,
        ),
      }),
    );
    if (!isValidCommitMessage(message)) {
      message = cleanCommitMessage(
        await task.generate({
          instructions: COMMIT_MESSAGE_SYSTEM_PROMPT,
          prompt: buildRepairCommitMessagePrompt(message, staged),
        }),
      );
    }
    if (!isValidCommitMessage(message)) {
      update(repoRoot, { error: { kind: "invalid" } });
    } else if (current(repoRoot).revision === revision) {
      update(repoRoot, { text: message });
    }
  } catch (error) {
    update(repoRoot, {
      error: {
        kind: "request",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    update(repoRoot, { running: false });
  }
}
