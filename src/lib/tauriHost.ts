/**
 * 本文件将 Tauri IPC、流式 Channel 和当前 Workspace 接入共享宿主接口。
 * 桌面保持原有通信方式，不增加后台进程或额外 IPC 往返。
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { NativeHost } from "@/lib/nativeHost";

export const tauriHost: NativeHost = {
  invoke,
  channel: <T>() => new Channel<T>(),
  workspace: currentWorkspaceEnv,
};
