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
  | "canceling"
  | "completed"
  | "failed"
  | "canceled";

export type TransferStage =
  | "queued"
  | "scanning"
  | "archiving"
  | "transferring"
  | "extracting"
  | "verifying"
  | "finalizing"
  | "finished";

export type EnqueueTransferRequest = {
  direction: TransferDirection;
  sources: string[];
  destination: string;
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
  totalRoots: number;
  committedRoots: number;
  speedBytesPerSecond: number;
  currentFile: string | null;
  failure: TransferFailure | null;
  createdAt: number;
  updatedAt: number;
};

/** 判断任务是否仍需要保留后台执行控制。 */
export function isActiveTransfer(task: TransferTask): boolean {
  return (
    task.status === "queued" ||
    task.status === "running" ||
    task.status === "paused" ||
    task.status === "canceling"
  );
}
