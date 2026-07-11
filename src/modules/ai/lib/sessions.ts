import type { UIMessage } from "@ai-sdk/react";
import { invoke } from "@tauri-apps/api/core";
import type { Todo } from "./todos";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modifiedAt?: number;
  size?: number;
  fingerprint?: string;
};

export type SessionSnapshot = {
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: UIMessage[];
  todos: Todo[];
};

export function listSessions(): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("ai_sessions_list");
}

export function readSession(id: string): Promise<SessionSnapshot> {
  return invoke<SessionSnapshot>("ai_session_read", { id });
}

export function publishSession(snapshot: SessionSnapshot): Promise<void> {
  return invoke("ai_session_publish", { snapshot });
}

export function deleteSessionFile(id: string): Promise<void> {
  return invoke("ai_session_delete", { id });
}

export function acquireSessionRun(id: string): Promise<boolean> {
  return invoke<boolean>("ai_session_run_acquire", { id });
}

export function releaseSessionRun(id: string): Promise<void> {
  return invoke("ai_session_run_release", { id });
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

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
