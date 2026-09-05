/**
 * 本文件封装 AI 会话的 Tauri IPC，并隔离磁盘 JSONL 与前端运行时类型。
 * 外层环境与 Agent 归属由 Rust 投影，内层业务 metadata 由前端解释，消息记录不直接依赖 AI SDK。
 */

import type { UIMessage } from "@ai-sdk/react";
import { invoke } from "@tauri-apps/api/core";
import { normalizeAgentIcon, type AgentIconId } from "./agents";
import type { SessionMessage } from "./sessionMessages";

/** Rust 不解释的会话业务 metadata，由前端按需扩展。 */
export type SessionData = Record<string, unknown>;

/** 前端高频轮询使用的会话摘要，时间统一为毫秒值。 */
export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  environmentKey: string;
  cwd: string;
  agentId: string;
  agentName: string;
  agentIcon: AgentIconId;
  channelId?: string;
  modifiedAt?: number;
  size?: number;
  fingerprint?: string;
};

/** IPC 封装对外提供的 SDK 无关会话文件。 */
export type SessionFile = {
  id: string;
  createdAt: number;
  updatedAt: number;
  environmentKey: string;
  cwd: string;
  metadata: SessionData;
  messages: SessionMessage[];
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

/** 解析会话实际使用的固定工作目录，草稿尚未发送时跟随 Explorer 根目录。 */
export function resolveSessionCwd(
  sessionId: string,
  draftSessionId: string | null,
  sessions: readonly SessionMeta[],
  explorerRoot: string | null,
): string | null {
  const persisted = sessions.find((session) => session.id === sessionId);
  if (persisted) return persisted.cwd;
  return sessionId === draftSessionId ? explorerRoot : null;
}

/** 判断活动会话是否为当前环境中已持久化、可导航到固定 cwd 的会话。 */
export function canRevealSessionCwd(
  sessionId: string | null,
  draftSessionId: string | null,
  sessions: readonly SessionMeta[],
  environmentKey: string,
): boolean {
  if (!sessionId || sessionId === draftSessionId) return false;
  return sessions.some(
    (session) =>
      session.id === sessionId && session.environmentKey === environmentKey,
  );
}

/** 提交本次新增记录，并取得原子替换后文件的真实会话摘要。 */
export async function commitSession(
  session: SessionFile,
): Promise<SessionMeta> {
  const ipcSession: IpcSessionFile = {
    ...session,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
  };
  const meta = await invoke<IpcSessionMeta>("ai_session_commit", {
    session: ipcSession,
  });
  return fromIpcMeta(meta);
}

/** 删除指定会话文件。 */
export function deleteSessionFile(id: string): Promise<void> {
  return invoke("ai_session_delete", { id });
}

/** 清理指定聊天拥有的 Agent Shell 进程和文件工具运行时状态。 */
export async function clearSessionProcesses(id: string): Promise<void> {
  await Promise.all([
    invoke("shell_clear_owner", { ownerSessionId: id }),
    invoke("agent_file_clear_owner", { ownerSessionId: id }),
  ]);
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

/** 显式投影 IPC 会话摘要，避免未来检查字段意外进入高频列表状态。 */
function fromIpcMeta(meta: IpcSessionMeta): SessionMeta {
  return {
    id: meta.id,
    title: meta.title,
    createdAt: parseTimestamp(meta.createdAt),
    updatedAt: parseTimestamp(meta.updatedAt),
    channelId: meta.channelId,
    environmentKey: meta.environmentKey,
    cwd: meta.cwd,
    agentId: meta.agentId,
    agentName: meta.agentName,
    agentIcon: normalizeAgentIcon(
      meta.agentIcon,
      meta.agentId === "builtin:main" ? "coder" : "spark",
    ),
    modifiedAt: meta.modifiedAt,
    size: meta.size,
    fingerprint: meta.fingerprint,
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
