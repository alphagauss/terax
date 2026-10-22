/**
 * 本文件封装 AI 会话的原生宿主调用，并隔离磁盘 JSONL 与前端运行时类型。
 * 外层环境与 Agent 归属由 Rust 投影，内层业务 metadata 由前端解释，消息记录不直接依赖 AI SDK。
 */

import { invokeNative as invoke } from "@/lib/nativeHost";
import {
  type AgentIconId,
  normalizeAgentIcon,
} from "@/modules/ai/lib/agentDefinition";
import type { SessionMessage } from "@/modules/ai/lib/conversation";
import type { UIMessage } from "@ai-sdk/react";

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

export type SessionContentMatch = {
  id: string;
  preview: string;
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

/** 搜索指定会话中的用户与助手可见文本。 */
export function searchSessionContents(
  query: string,
  sessionIds: string[],
): Promise<SessionContentMatch[]> {
  return invoke("ai_sessions_search", { query, sessionIds });
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

/** 解析会话工作目录；草稿默认跟随 Explorer，也可单独重置到默认目录。 */
export function resolveSessionCwd(
  sessionId: string,
  draftSessionId: string | null,
  sessions: readonly SessionMeta[],
  explorerRoot: string | null,
  draftOverride?: { sessionId: string; cwd: string } | null,
): string | null {
  const persisted = sessions.find((session) => session.id === sessionId);
  if (persisted) return persisted.cwd;
  if (sessionId !== draftSessionId) return null;
  return draftOverride?.sessionId === sessionId
    ? draftOverride.cwd
    : explorerRoot;
}

/** 判断活动会话是否可导航到当前环境中的工作目录。 */
export function canRevealSessionCwd(
  sessionId: string | null,
  draftSessionId: string | null,
  sessions: readonly SessionMeta[],
  environmentKey: string,
): boolean {
  if (!sessionId) return false;
  if (sessionId === draftSessionId) return true;
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

/** 按明确范围清理聊天进程，等待工具收尾后再释放文件工具状态。 */
export async function clearSessionProcesses(
  id: string,
  toolsSettled?: Promise<void>,
  scope: "all" | "active" = "all",
): Promise<void> {
  const cleanup = await Promise.allSettled([
    invoke(scope === "all" ? "shell_clear_owner" : "shell_stop_active", { ownerSessionId: id }),
    toolsSettled,
  ]);
  // 进程先终止以唤醒工具；文件运行时必须等工具收尾后再释放。
  await invoke("agent_file_clear_owner", { ownerSessionId: id });
  const failed = cleanup.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
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

/** 从第一条有效用户文本推导简短会话标题，合并空白后截断。 */
export function deriveTitle(messages: UIMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      const text = (p as { text: string }).text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      return text.length > 40 ? `${text.slice(0, 40)}…` : text;
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

/** 分叉边界使用持久化身份，压缩检查点不依赖普通助手回复。 */
export type SessionForkTarget =
  | { kind: "reply"; turn_id: string }
  | { kind: "compaction"; checkpoint_id: string };

/** 在持有运行锁期间原子修改历史，原生层再次校验磁盘版本。 */
export async function reviseSessionHistory(
  id: string,
  fingerprint: string,
  action:
    | { kind: "edit"; message_id: string; text: string; turn_id: string }
    | { kind: "fork"; target: SessionForkTarget; label: string },
): Promise<{ meta: SessionMeta; session: SessionFile }> {
  const result = await invoke<{
    meta: IpcSessionMeta;
    session: IpcSessionFile;
  }>("ai_session_revise_history", {
    id,
    fingerprint,
    action,
    now: new Date().toISOString(),
  });
  return {
    meta: fromIpcMeta(result.meta),
    session: {
      ...result.session,
      createdAt: parseTimestamp(result.session.createdAt),
      updatedAt: parseTimestamp(result.session.updatedAt),
    },
  };
}
