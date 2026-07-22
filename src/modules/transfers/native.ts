/**
 * 本文件封装文件传输 Tauri IPC 与运行时事件。
 * 环境归属由 Rust Workspace 状态决定，前端请求不携带 SSH profile。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EnqueueTransferRequest, TransferTask } from "./types";

const TRANSFER_EVENT = "terax://transfer-updated";

/** 文件传输命令与增量事件的原生适配器。 */
export const transferNative = {
  enqueue: (request: EnqueueTransferRequest) =>
    invoke<TransferTask>("transfer_enqueue", { request }),
  list: () => invoke<TransferTask[]>("transfer_list"),
  pause: (id: string) => invoke<void>("transfer_pause", { id }),
  resume: (id: string) => invoke<void>("transfer_resume", { id }),
  cancel: (id: string) => invoke<void>("transfer_cancel", { id }),
  remove: (id: string) => invoke<void>("transfer_remove", { id }),
  onUpdated: (handler: (task: TransferTask) => void): Promise<UnlistenFn> =>
    listen<TransferTask>(TRANSFER_EVENT, (event) => handler(event.payload)),
};
