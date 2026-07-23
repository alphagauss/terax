/**
 * 本文件定义文件传输前后端共享的 TypeScript 模型。
 * Direct 与 Archive 由用户显式选择，但共享同一任务生命周期和状态字段。
 */

export type TransferDirection = "upload" | "download";
export type TransferStrategy = "direct" | "archive";

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
  speedBytesPerSecond: number;
  currentFile: string | null;
  error: string | null;
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
