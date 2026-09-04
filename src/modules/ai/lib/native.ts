/**
 * 本文件定义前端与 Tauri 原生命令之间的类型化调用边界。
 * 负责注入当前工作区环境，并为文件工具暴露版本化条件写入，不包含业务状态或缓存。
 */

import type { GitDiffSide } from "@/modules/source-control/gitTypes";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";

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
  | "powershell"
  | "cmd";

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
    before: string;
    after: string;
    isNewFile: boolean;
    replacements: number;
  }>;
};

export type AgentMutationResult = {
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
  refs: string[];
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
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

export type GitPanelSnapshot = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
};

export type GitDiscardEntry = {
  path: string;
  untracked: boolean;
};

export type GitBranchEntry = {
  name: string;
  kind: "local" | "worktree";
  worktreePath: string | null;
  isHead: boolean;
  isDetached: boolean;
};

export type GitBranchListResult = {
  branches: GitBranchEntry[];
};

export const native = {
  workspaceCurrentDir: () => invoke<string>("workspace_current_dir"),
  workspaceAuthorize: (path: string) =>
    invoke<string>("workspace_authorize", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  readFile: (path: string) =>
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  canonicalize: (path: string) =>
    invoke<string>("fs_canonicalize", {
      path,
      workspace: currentWorkspaceEnv(),
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
      request: { ...params, workspace: currentWorkspaceEnv() },
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
      request: { ...params, workspace: currentWorkspaceEnv() },
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
      request: { ...params, workspace: currentWorkspaceEnv() },
    }),
  agentPrepareMutation: (params: {
    ownerSessionId: string;
    toolCallId: string;
    root: string;
    permissionMode: AgentPermissionMode;
    mutation: AgentMutationInput;
  }) =>
    invoke<AgentMutationPreview>("agent_file_prepare_mutation", {
      request: { ...params, workspace: currentWorkspaceEnv() },
    }),
  agentCommitMutation: (ownerSessionId: string, toolCallId: string) =>
    invoke<AgentMutationResult>("agent_file_commit_mutation", {
      request: { ownerSessionId, toolCallId },
    }),
  agentClearMutation: (ownerSessionId: string, toolCallId: string) =>
    invoke<void>("agent_file_clear_mutation", {
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
      request: { ...params, workspace: currentWorkspaceEnv() },
    }),
  runCommand: (command: string, cwd?: string | null, timeoutSecs?: number) =>
    invoke<CommandOutput>("shell_run_command", {
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: currentWorkspaceEnv(),
    }),

  shellExec: (params: {
    ownerSessionId: string;
    command: string;
    initialCwd: string;
    cwd?: string | null;
    timeoutSecs: number;
    yieldTimeMs: number;
    maxOutputBytes: number;
    shell: ShellKind;
    login: boolean;
  }) =>
    invoke<ShellProcessResponse>("shell_exec", {
      ...params,
      cwd: params.cwd ?? null,
      workspace: currentWorkspaceEnv(),
    }),
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
      workspace: currentWorkspaceEnv(),
    }),
  shellList: (ownerSessionId: string, includeExited = false) =>
    invoke<ShellProcessInfo[]>("shell_list", {
      ownerSessionId,
      includeExited,
      workspace: currentWorkspaceEnv(),
    }),
  gitResolveRepo: (cwd: string) =>
    invoke<GitRepoInfo | null>("git_resolve_repo", {
      cwd,
      workspace: currentWorkspaceEnv(),
    }),
  gitPanelSnapshot: (cwd: string) =>
    invoke<GitPanelSnapshot>("git_panel_snapshot", {
      cwd,
      workspace: currentWorkspaceEnv(),
    }),
  gitStatus: (repoRoot: string) =>
    invoke<GitStatusSnapshot>("git_status", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitDiff: (repoRoot: string, path: string | null, side: GitDiffSide) =>
    invoke<GitDiffResult>("git_diff", {
      repoRoot,
      path,
      side,
      workspace: currentWorkspaceEnv(),
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
      workspace: currentWorkspaceEnv(),
    }),
  gitStage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_stage", {
      repoRoot,
      paths,
      workspace: currentWorkspaceEnv(),
    }),
  gitUnstage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_unstage", {
      repoRoot,
      paths,
      workspace: currentWorkspaceEnv(),
    }),
  gitDiscard: (repoRoot: string, entries: GitDiscardEntry[]) =>
    invoke<void>("git_discard", {
      repoRoot,
      entries,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommit: (repoRoot: string, message: string) =>
    invoke<GitCommitResult>("git_commit", {
      repoRoot,
      message,
      workspace: currentWorkspaceEnv(),
    }),
  gitUndoCommit: (repoRoot: string, expectedHead: string) =>
    invoke<void>("git_undo_commit", {
      repoRoot,
      expectedHead,
      workspace: currentWorkspaceEnv(),
    }),
  gitFetch: (repoRoot: string) =>
    invoke<void>("git_fetch", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitPullFfOnly: (repoRoot: string) =>
    invoke<void>("git_pull_ff_only", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitPush: (repoRoot: string) =>
    invoke<GitPushResult>("git_push", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitLog: (
    repoRoot: string,
    options?: { limit?: number; beforeSha?: string },
  ) =>
    invoke<GitLogEntry[]>("git_log", {
      repoRoot,
      limit: options?.limit ?? null,
      beforeSha: options?.beforeSha ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  gitShowCommit: (repoRoot: string, sha: string) =>
    invoke<GitDiffResult>("git_show_commit", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommitMessage: (repoRoot: string, sha: string) =>
    invoke<string>("git_commit_message", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommitFiles: (repoRoot: string, sha: string) =>
    invoke<GitCommitFileChange[]>("git_commit_files", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
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
      workspace: currentWorkspaceEnv(),
    }),
  gitRemoteUrl: (repoRoot: string, name?: string) =>
    invoke<string | null>("git_remote_url", {
      repoRoot,
      name: name ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  gitListBranches: (repoRoot: string) =>
    invoke<GitBranchListResult>("git_list_branches", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitCheckoutBranch: (repoRoot: string, branch: string) =>
    invoke<void>("git_checkout_branch", {
      repoRoot,
      branch,
      workspace: currentWorkspaceEnv(),
    }),
};
