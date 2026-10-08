/**
 * 本文件封装文件传输 Tauri IPC 与运行时事件。
 * Direct 与 Archive 使用统一入队命令；环境归属仍由 Rust Workspace 状态决定。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  EnqueueTransferRequest,
  ResolveTransferConflictRequest,
  TransferTask,
  SyncPreview,
} from "@/modules/transfers/types";

const TRANSFER_EVENT = "terax://transfer-updated";
const TRANSFER_REMOVED_EVENT = "terax://transfer-removed";

/** 文件传输命令与增量事件的原生适配器。 */
export const transferNative = {
  syncPreview: (request: EnqueueTransferRequest) =>
    invoke<SyncPreview>("transfer_sync_preview", { request }),
  enqueue: (request: EnqueueTransferRequest) =>
    invoke<TransferTask>("transfer_enqueue", { request }),
  resolveConflict: (request: ResolveTransferConflictRequest) =>
    invoke<void>("transfer_resolve_conflict", { request }),
  ignoreFailure: (id: string, failureId: string) =>
    invoke<void>("transfer_ignore_failure", { id, failureId }),
  retryFailure: (id: string, failureId: string) =>
    invoke<void>("transfer_retry_failure", { id, failureId }),
  list: () => invoke<TransferTask[]>("transfer_list"),
  pause: (id: string) => invoke<void>("transfer_pause", { id }),
  resume: (id: string) => invoke<void>("transfer_resume", { id }),
  cancel: (id: string) => invoke<void>("transfer_cancel", { id }),
  retry: (id: string) => invoke<TransferTask>("transfer_retry", { id }),
  remove: (id: string) => invoke<void>("transfer_remove", { id }),
  clearCompleted: () => invoke<string[]>("transfer_clear_completed"),
  clearAll: () => invoke<string[]>("transfer_clear_all"),
  onUpdated: (handler: (task: TransferTask) => void): Promise<UnlistenFn> =>
    listen<TransferTask>(TRANSFER_EVENT, (event) => handler(event.payload)),
  onRemoved: (handler: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>(TRANSFER_REMOVED_EVENT, (event) => handler(event.payload)),
};
