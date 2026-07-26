/**
 * 本文件封装 AI 会话的 Tauri IPC，并隔离磁盘 JSONL 与前端运行时类型。
 * 时间戳在 IPC 边界转换为 ISO 字符串，消息记录不直接依赖 AI SDK。
 */

import type { UIMessage } from "@ai-sdk/react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionMessage } from "./sessionMessages";
import type { Todo } from "./todos";

/** 前端列表使用的会话 metadata，时间统一为毫秒值。 */
export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modifiedAt?: number;
  size?: number;
  fingerprint?: string;
};

/** IPC 封装对外提供的 SDK 无关会话文件。 */
export type SessionFile = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
  todos: Todo[];
};

type IpcSessionMeta = Omit<SessionMeta, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

type IpcSessionFile = Omit<SessionFile, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

/** 列出磁盘中的 JSONL 会话，并将 ISO 时间转换为前端毫秒值。 */
export async function listSessions(): Promise<SessionMeta[]> {
  const sessions = await invoke<IpcSessionMeta[]>("ai_sessions_list");
  return sessions.map(fromIpcMeta);
}

/** 读取完整会话文件，消息仍保持 SDK 无关的持久化记录。 */
export async function readSession(id: string): Promise<SessionFile> {
  const session = await invoke<IpcSessionFile>("ai_session_read", { id });
  return {
    ...session,
    createdAt: parseTimestamp(session.createdAt),
    updatedAt: parseTimestamp(session.updatedAt),
  };
}

/** 提交本次新增记录，Rust 侧负责读取旧记录并整体原子替换。 */
export function commitSession(session: SessionFile): Promise<void> {
  const ipcSession: IpcSessionFile = {
    ...session,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
  };
  return invoke("ai_session_commit", { session: ipcSession });
}

/** 删除指定会话文件。 */
export function deleteSessionFile(id: string): Promise<void> {
  return invoke("ai_session_delete", { id });
}

/** 尝试取得跨进程会话运行锁。 */
export function acquireSessionRun(id: string): Promise<boolean> {
  return invoke<boolean>("ai_session_run_acquire", { id });
}

/** 释放当前进程持有的会话运行锁。 */
export function releaseSessionRun(id: string): Promise<void> {
  return invoke("ai_session_run_release", { id });
}

/** 生成不带存储实现细节的新会话标识。 */
export function newSessionId(): string {
  return crypto.randomUUID();
}

/** 从第一条有效用户文本推导简短会话标题。 */
export function deriveTitle(messages: UIMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      const text = (p as { text: string }).text
        .replace(/<terminal-context[\s\S]*?<\/terminal-context>\s*/g, "")
        .replace(/<selection[\s\S]*?<\/selection>\s*/g, "")
        .replace(/<file[\s\S]*?<\/file>\s*/g, "")
        .trim();
      if (!text) continue;
      const first = text.split("\n")[0].trim();
      return first.length > 40 ? `${first.slice(0, 40)}…` : first;
    }
  }
  return "New chat";
}

/** 合并本进程的临时会话与磁盘元数据，并保护正在运行的会话。 */
export function mergeSessionMetadata(
  local: SessionMeta[],
  disk: SessionMeta[],
  runningIds: ReadonlySet<string>,
): SessionMeta[] {
  const preserved = local.filter(
    (session) => !session.fingerprint || runningIds.has(session.id),
  );
  const preservedIds = new Set(preserved.map((session) => session.id));
  return [
    ...preserved,
    ...disk.filter((session) => !preservedIds.has(session.id)),
  ].sort((left, right) => right.updatedAt - left.updatedAt);
}

/** 将 IPC 元数据中的 ISO 时间转换为毫秒值。 */
function fromIpcMeta(meta: IpcSessionMeta): SessionMeta {
  return {
    ...meta,
    createdAt: parseTimestamp(meta.createdAt),
    updatedAt: parseTimestamp(meta.updatedAt),
  };
}

/** 严格解析后端返回的会话时间，避免无效时间污染排序。 */
function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid session timestamp: ${value}`);
  }
  return timestamp;
}
