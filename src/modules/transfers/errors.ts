/**
 * 本文件将文件传输结构化错误转换为本地化用户提示。
 * 错误码决定稳定文案，后端诊断细节只用于补充排障，不参与前端控制流。
 */

import type { TFunction } from "i18next";
import type { TransferErrorCode, TransferFailure } from "./types";

const TRANSFER_ERROR_CODES = new Set<TransferErrorCode>([
  "invalid_request",
  "workspace_unavailable",
  "source_unavailable",
  "source_changed",
  "destination_exists",
  "destination_busy",
  "archive_unavailable",
  "integrity_check_failed",
  "permission_denied",
  "connection_lost",
  "storage_full",
  "resource_limit",
  "task_not_found",
  "invalid_task_state",
  "io_failed",
  "internal",
]);

/** 从 Tauri 拒绝值中安全提取文件传输失败对象。 */
export function parseTransferFailure(error: unknown): TransferFailure | null {
  if (!error || typeof error !== "object") return null;
  const value = error as Record<string, unknown>;
  if (
    typeof value.code !== "string" ||
    !TRANSFER_ERROR_CODES.has(value.code as TransferErrorCode) ||
    typeof value.detail !== "string" ||
    typeof value.retryable !== "boolean"
  ) {
    return null;
  }
  return value as TransferFailure;
}

/** 按稳定错误码生成本地化说明。 */
export function formatTransferFailure(
  failure: TransferFailure,
  t: TFunction,
): string {
  return t(`statusbar:transfers.errors.${failure.code}`);
}

/** 本地化 Tauri 操作错误，并为非传输错误保留可诊断文本。 */
export function formatTransferError(
  error: unknown,
  t: TFunction,
): string {
  const failure = parseTransferFailure(error);
  return failure
    ? formatTransferFailure(failure, t)
    : t("statusbar:transfers.errors.unknown", { detail: String(error) });
}
