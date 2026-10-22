/**
 * 本文件定义共享业务与原生宿主之间的类型化调用边界。
 * 通过宿主注入当前工作区环境，并传递文件条件写入与 Shell 访问级别，不包含业务状态或缓存。
 */

import type { GitDiffSide } from "@/modules/source-control/gitTypes";
import { invokeNative, invokeWorkspace as invoke } from "@/lib/nativeHost";

export type ReadResult =
  | {
      kind: "text";
      content: string;
      size: number;
      mtime: number;
      revision: string;
    }
  | { kind: "binary"; size: number; mtime: number }
  | { kind: "toolarge"; size: number; limit: number; mtime: number };

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
};

export type ShellKind =
  | "default"
  | "bash"
  | "sh"
  | "zsh"
  | "pwsh"
  | "powershell"
  | "cmd";

/** 实际执行环境的原生 Shell 快照，列表首项为默认。 */
export type ShellIdentity = {
  kind: Exclude<ShellKind, "default">;
  executable: string;
  version: string | null;
};

export type ShellProcessStatus =
  | "running"
  | "exited"
  | "timed_out"
  | "terminated";

export type ShellProcessResponse = {
  process_id: string;
  status: ShellProcessStatus;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  elapsed_ms: number;
  truncated: boolean;
  dropped_bytes: number;
  next_offset: number;
  available_from: number;
  cwd: string;
  cwd_after: string | null;
  wait_for_matched: boolean | null;
};

export type ShellProcessInfo = {
  execution_id?: string | null;
  task_id?: string | null;
  process_id: string;
  command: string;
  cwd: string;
  shell: ShellKind;
  workspace: "local" | "wsl" | "ssh";
  status: ShellProcessStatus;
  started_at_ms: number;
  elapsed_ms: number;
  idle_ms: number;
  exit_code: number | null;
  unread_output: boolean;
};

export type AgentReadResponse = {
  path: string;
  content: string;
  size: number;
  startLine: number;
  endLine: number;
  totalLines: number;
  nextLine: number | null;
  truncated: boolean;
  lineTruncated: boolean;
  unchanged: boolean;
};

export type AgentFindResponse = {
  root: string;
  entries: Array<{
    path: string;
    rel: string;
    kind: "file" | "directory" | "symlink";
    size: number;
  }>;
  nextOffset: number | null;
  truncated: boolean;
};

export type AgentGrepResponse = {
  root: string;
  output: "content" | "files" | "count";
  hits: Array<{
    path: string;
    rel: string;
    line: number;
    text: string;
    before: Array<{ line: number; text: string }>;
    after: Array<{ line: number; text: string }>;
  }>;
  files: string[];
  counts: Array<{ path: string; count: number }>;
  filesScanned: number;
  nextOffset: number | null;
  truncated: boolean;
};

export type AgentMutationInput =
  | {
      kind: "write";
      path: string;
      content: string;
      mode: "create" | "rewrite";
    }
  | {
      kind: "patch";
      files: Array<{
        path: string;
        edits: Array<{
          old_text: string;
          new_text: string;
          replace_all?: boolean;
        }>;
      }>;
    };

export type AgentMutationPreview = {
  files: Array<{
    path: string;
    identity: string;
    before: string;
    after: string;
    isNewFile: boolean;
    replacements: number;
  }>;
};

export type AgentMutationResult = {
  error?: string;
  uncertainPaths?: string[];
  files: Array<{
    path: string;
    bytesWritten: number;
    replacements: number;
  }>;
};

export type AgentFileOperationResponse = {
  operation: "move" | "copy" | "delete" | "create_directory";
  path: string;
  destination: string | null;
  ok: boolean;
};

export type AgentPermissionMode = "ask" | "full-access";

export type GitRepoInfo = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  isDetached: boolean;
};

export type GitChangedFile = {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  statusLabel: string;
};

export type GitStatusSnapshot = {
  repoRoot: string;
  branch: string;
  headSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;
  truncated: boolean;
  changedFiles: GitChangedFile[];
};

export type GitDiffResult = {
  diffText: string;
  truncated: boolean;
};

export type GitDiffContentResult = {
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  fallbackPatch: string;
  truncated: boolean;
};

export type GitCommitResult = {
  commitSha: string;
  summary: string;
};

export type GitPushResult = {
  remote: string | null;
  branch: string | null;
  pushed: boolean;
};

export type GitLogEntry = {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  timestampSecs: number;
  parents: string[];
  refs: GitLogRef[];
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type GitFileHistoryEntry = GitLogEntry & {
  path: string;
  originalPath: string | null;
};

/** 打开提交文件 Diff 的公共输入，路径属于对应历史提交。 */
export type CommitFileDiffOpenInput = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

export type GitLogRefKind = "local" | "remote" | "tag";

export type GitLogRef = {
  label: string;
  kind: GitLogRefKind;
};

export type GitCommitFileChange = {
  path: string;
  originalPath: string | null;
  status: string;
  statusLabel: string;
  added: number;
  removed: number;
  isBinary: boolean;
};

export type GitFileLineStats = {
  added: number;
  removed: number;
  incomplete: boolean;
  isBinary: boolean;
};

export type GitLineStats = {
  files: Record<string, GitFileLineStats>;
  added: number;
  removed: number;
  incomplete: boolean;
};
export type GitPanelDiffStats = {
  worktree: GitLineStats | null;
  index: GitLineStats | null;
};

export type GitPanelSnapshot = {
  diffStats: GitPanelDiffStats | null;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
};

export type GitDiscardEntry = {
  path: string;
  untracked: boolean;
};

export type GitBranchEntry = {
  name: string;
  kind: "local" | "remote" | "worktree";
  worktreePath: string | null;
  isHead: boolean;
  isDetached: boolean;
  timestampSecs: number | null;
};

export type GitBranchListResult = {
  branches: GitBranchEntry[];
};

export const native = {
  shellEnvironment: () => invoke<ShellIdentity[]>("shell_environment"),
  workspaceCurrentDir: () => invokeNative<string>("workspace_current_dir"),
  workspaceAuthorize: (path: string) =>
    invoke<string>("workspace_authorize", {
      path,
    }),
  readFile: (path: string) =>
    invoke<ReadResult>("fs_read_file", {
      path,
    }),
  fileVersion: (path: string) =>
    invoke<{ revision: string } | null>("fs_file_version", { path }),
  canonicalize: (path: string) =>
    invoke<string>("fs_canonicalize", {
      path,
    }),
  agentFileRead: (params: {
    ownerSessionId: string;
    root: string;
    permissionMode: AgentPermissionMode;
    path: string;
    startLine?: number;
    lineCount?: number;
    force?: boolean;
  }) =>
    invoke<AgentReadResponse>("agent_file_read", {
      request: { ...params },
    }),
  agentFileFind: (params: {
    ownerSessionId: string;
    root: string;
    permissionMode: AgentPermissionMode;
    path?: string;
    glob?: string;
    recursive?: boolean;
    includeDirectories?: boolean;
    includeHidden?: boolean;
    offset?: number;
    limit?: number;
  }) =>
    invoke<AgentFindResponse>("agent_file_find", {
      request: { ...params },
    }),
  agentFileGrep: (params: {
    ownerSessionId: string;
    root: string;
    permissionMode: AgentPermissionMode;
    path?: string;
    pattern: string;
    syntax?: "literal" | "regex";
    caseInsensitive?: boolean;
    include?: string[];
    output?: "content" | "files" | "count";
    contextLines?: number;
    offset?: number;
    limit?: number;
  }) =>
    invoke<AgentGrepResponse>("agent_file_grep", {
      request: { ...params },
    }),
  agentPrepareMutation: (params: {
    ownerSessionId: string;
    toolCallId: string;
    root: string;
    permissionMode: AgentPermissionMode;
    mutation: AgentMutationInput;
  }) =>
    invoke<AgentMutationPreview>("agent_file_prepare_mutation", {
      request: { ...params },
    }),
  agentCommitMutation: (ownerSessionId: string, toolCallId: string) =>
    invokeNative<AgentMutationResult>("agent_file_commit_mutation", {
      request: { ownerSessionId, toolCallId },
    }),
  agentClearMutation: (ownerSessionId: string, toolCallId: string) =>
    invokeNative<void>("agent_file_clear_mutation", {
      request: { ownerSessionId, toolCallId },
    }),
  agentFileOperation: (params: {
    ownerSessionId: string;
    root: string;
    permissionMode: AgentPermissionMode;
    operation: "move" | "copy" | "delete" | "create_directory";
    path: string;
    destination?: string;
    recursive?: boolean;
  }) =>
    invoke<AgentFileOperationResponse>("agent_file_operation", {
      request: { ...params },
    }),
  runCommand: (command: string, cwd?: string | null, timeoutSecs?: number) =>
    invoke<CommandOutput>("shell_run_command", {
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
    }),

  shellExec: (params: {
    ownerSessionId: string;
    executionId?: string;
    command: string;
    initialCwd: string;
    cwd?: string | null;
    permissionMode: AgentPermissionMode;
    timeoutSecs: number;
    yieldTimeMs: number;
    maxOutputBytes: number;
    shell: ShellKind;
    login: boolean;
  }) =>
    invoke<ShellProcessResponse>("shell_exec", {
      ...params,
      cwd: params.cwd ?? null,
    }),
  shellOpenExecution: (
    ownerSessionId: string,
    executionId: string,
    taskId?: string,
  ) =>
    invoke<void>("shell_open_execution", {
      ownerSessionId,
      executionId,
      taskId,
    }),
  shellStopExecution: (ownerSessionId: string, executionId: string) =>
    invoke<void>("shell_stop_execution", { ownerSessionId, executionId }),
  shellCloseExecution: (ownerSessionId: string, executionId: string) =>
    invoke<void>("shell_close_execution", { ownerSessionId, executionId }),
  shellStopTask: (ownerSessionId: string, taskId: string) =>
    invoke<void>("shell_stop_task", { ownerSessionId, taskId }),
  shellProcess: (params: {
    ownerSessionId: string;
    processId: string;
    action: "poll" | "write" | "close_stdin" | "terminate";
    input?: string | null;
    closeStdin?: boolean;
    sinceOffset?: number | null;
    yieldTimeMs?: number | null;
    waitFor?: string | null;
    waitTimeoutMs?: number | null;
    maxOutputBytes?: number | null;
  }) =>
    invoke<ShellProcessResponse>("shell_process", {
      input: null,
      closeStdin: false,
      sinceOffset: null,
      yieldTimeMs: null,
      waitFor: null,
      waitTimeoutMs: null,
      maxOutputBytes: null,
      ...params,
    }),
  shellList: (ownerSessionId: string, includeExited = false) =>
    invoke<ShellProcessInfo[]>("shell_list", {
      ownerSessionId,
      includeExited,
    }),
  gitResolveRepo: (cwd: string) =>
    invoke<GitRepoInfo | null>("git_resolve_repo", {
      cwd,
    }),
  gitPanelSnapshot: (cwd: string) =>
    invoke<GitPanelSnapshot>("git_panel_snapshot", {
      cwd,
    }),
  gitGraphRevision: (repoRoot: string) =>
    invoke<string>("git_graph_revision", { repoRoot }),
  gitStatus: (repoRoot: string) =>
    invoke<GitStatusSnapshot>("git_status", {
      repoRoot,
    }),
  gitDiff: (repoRoot: string, path: string | null, side: GitDiffSide) =>
    invoke<GitDiffResult>("git_diff", {
      repoRoot,
      path,
      side,
    }),
  gitDiffContent: (
    repoRoot: string,
    path: string,
    side: GitDiffSide,
    originalPath?: string | null,
  ) =>
    invoke<GitDiffContentResult>("git_diff_content", {
      repoRoot,
      path,
      side,
      originalPath: originalPath ?? null,
    }),
  gitStage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_stage", {
      repoRoot,
      paths,
    }),
  gitUnstage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_unstage", {
      repoRoot,
      paths,
    }),
  gitDiscard: (repoRoot: string, entries: GitDiscardEntry[]) =>
    invoke<void>("git_discard", {
      repoRoot,
      entries,
    }),
  gitCommit: (repoRoot: string, message: string) =>
    invoke<GitCommitResult>("git_commit", {
      repoRoot,
      message,
    }),
  gitUndoCommit: (repoRoot: string, expectedHead: string) =>
    invoke<void>("git_undo_commit", {
      repoRoot,
      expectedHead,
    }),
  gitFetch: (repoRoot: string) =>
    invoke<void>("git_fetch", {
      repoRoot,
    }),
  gitPullFfOnly: (repoRoot: string) =>
    invoke<void>("git_pull_ff_only", {
      repoRoot,
    }),
  gitPush: (repoRoot: string) =>
    invoke<GitPushResult>("git_push", {
      repoRoot,
    }),
  gitLog: (repoRoot: string, options?: { limit?: number; skip?: number }) =>
    invoke<GitLogEntry[]>("git_log", {
      repoRoot,
      limit: options?.limit ?? null,
      skip: options?.skip ?? null,
    }),
  gitFileHistory: (
    repoRoot: string,
    path: string,
    headSha: string,
    options?: { limit?: number; skip?: number },
  ) =>
    invoke<GitFileHistoryEntry[]>("git_file_history", {
      repoRoot,
      path,
      headSha,
      limit: options?.limit ?? null,
      skip: options?.skip ?? null,
    }),
  gitShowCommit: (repoRoot: string, sha: string) =>
    invoke<GitDiffResult>("git_show_commit", {
      repoRoot,
      sha,
    }),
  gitCommitMessage: (repoRoot: string, sha: string) =>
    invoke<string>("git_commit_message", {
      repoRoot,
      sha,
    }),
  gitCommitFiles: (repoRoot: string, sha: string) =>
    invoke<GitCommitFileChange[]>("git_commit_files", {
      repoRoot,
      sha,
    }),
  gitCommitFileDiff: (
    repoRoot: string,
    sha: string,
    path: string,
    originalPath?: string | null,
  ) =>
    invoke<GitDiffContentResult>("git_commit_file_diff", {
      repoRoot,
      sha,
      path,
      originalPath: originalPath ?? null,
    }),
  gitRemoteUrl: (repoRoot: string, name?: string) =>
    invoke<string | null>("git_remote_url", {
      repoRoot,
      name: name ?? null,
    }),
  gitListBranches: (repoRoot: string) =>
    invoke<GitBranchListResult>("git_list_branches", {
      repoRoot,
    }),
  gitCheckoutBranch: (repoRoot: string, branch: string, trackRemote = false) =>
    invoke<void>("git_checkout_branch", {
      repoRoot,
      branch,
      trackRemote,
    }),
};
