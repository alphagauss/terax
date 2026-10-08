/**
 * 本文件定义文件传输前后端共享的 TypeScript 模型。
 * Direct 与 Archive 由用户显式选择，但共享同一任务生命周期和状态字段。
 */

export type TransferDirection = "upload" | "download";
export type TransferStrategy = "direct" | "archive";

export type TransferErrorCode =
  | "invalid_request"
  | "workspace_unavailable"
  | "source_unavailable"
  | "source_changed"
  | "destination_exists"
  | "destination_busy"
  | "archive_unavailable"
  | "integrity_check_failed"
  | "permission_denied"
  | "connection_lost"
  | "storage_full"
  | "resource_limit"
  | "task_not_found"
  | "invalid_task_state"
  | "io_failed"
  | "internal";

export type TransferFailure = {
  code: TransferErrorCode;
  detail: string;
  retryable: boolean;
};

export type TransferStatus =
  | "queued"
  | "running"
  | "paused"
  | "awaiting_decision"
  | "canceling"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "canceled";

export type TransferStage =
  | "queued"
  | "scanning"
  | "checking_conflicts"
  | "archiving"
  | "transferring"
  | "extracting"
  | "verifying"
  | "finalizing"
  | "finished";

export type EnqueueTransferRequest = {
  sync?: {
    excludes: string[];
    excludeDirectories: string[];
    respectGitignore: boolean;
  };
  destinationName?: string;
  direction: TransferDirection;
  strategy: TransferStrategy;
  sources: string[];
  destination: string;
};

export type SyncPreview = {
  added: number;
  updated: number;
  skipped: number;
  conflicts: number;
  bytes: number;
  items: { path: string; action: "add" | "update" | "skip" | "conflict" }[];
  truncated: boolean;
};

export type TransferEntryKind = "file" | "directory" | "other";
export type TransferConflictKind =
  | "file"
  | "archive_directory"
  | "type_mismatch";
export type TransferConflictDecision =
  | "cancel"
  | "skip"
  | "replace"
  | "replace_directory"
  | "merge"
  | "merge_skip";

export type TransferConflict = {
  id: string;
  kind: TransferConflictKind;
  sourceKind: TransferEntryKind;
  destinationKind: TransferEntryKind;
  sourcePath: string;
  destinationPath: string;
  decisions: TransferConflictDecision[];
  allowApplyToRemaining: boolean;
};

export type ResolveTransferConflictRequest = {
  taskId: string;
  conflictId: string;
  decision: TransferConflictDecision;
  applyToRemaining: boolean;
};

export type TransferFileFailure = {
  id: string;
  sourcePath: string;
  destinationPath: string;
  failure: TransferFailure;
  attempts: number;
  ignored: boolean;
};

export type TransferTask = {
  id: string;
  direction: TransferDirection;
  strategy: TransferStrategy;
  status: TransferStatus;
  stage: TransferStage;
  sourceCount: number;
  destination: string;
  name: string;
  totalBytes: number;
  transferredBytes: number;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  unprocessedFiles: number;
  totalRoots: number;
  committedRoots: number;
  speedBytesPerSecond: number;
  currentFile: string | null;
  failure: TransferFailure | null;
  fileFailures: TransferFileFailure[];
  conflict: TransferConflict | null;
  isDirectory: boolean;
  createdAt: number;
  updatedAt: number;
};

/** 判断任务是否仍需要保留后台执行控制。 */
export function isActiveTransfer(task: TransferTask): boolean {
  return (
    task.status === "queued" ||
    task.status === "running" ||
    task.status === "paused" ||
    task.status === "awaiting_decision" ||
    task.status === "canceling"
  );
}

/** 仅允许已完成但有错误的 Direct 文件夹展开未忽略失败项。 */
export function hasExpandableTransferFailures(task: TransferTask): boolean {
  return (
    task.strategy === "direct" &&
    task.isDirectory &&
    task.status === "completed_with_errors" &&
    task.fileFailures.some((failure) => !failure.ignored)
  );
}
