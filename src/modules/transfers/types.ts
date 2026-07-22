/**
 * 本文件定义文件传输前后端共享的 TypeScript 模型。
 * 首版仅描述 Direct 任务，状态字段保持完整以便后续接入持久化恢复和同步任务。
 */

export type TransferDirection = "upload" | "download";

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
  | "transferring"
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
