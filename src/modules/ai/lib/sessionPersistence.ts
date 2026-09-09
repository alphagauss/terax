/**
 * 本文件统一桌面与终端的会话增量提交规则。
 * 用户输入先落盘，checkpoint 保留运行锁；游标只在原子提交成功后推进。
 */

import type { UIMessage } from "ai";
import type { SubagentDisplaySnapshot } from "@/modules/ai/agents/subagentDisplay";
import {
  conversationEventPart,
  serializeSessionMessages,
  serializeSubagentDisplaySnapshots,
  uncommittedConversationMessages,
  type TurnEvent,
} from "@/modules/ai/lib/conversation";
import { commitSession, type SessionFile } from "@/modules/ai/lib/sessions";
import { peekFileEditRuntime } from "@/modules/ai/lib/fileEditRuntime";
import {
  acknowledgeUsage,
  pendingUsage,
  settleUsage,
} from "@/modules/ai/lib/usageRuntime";

export type SessionCommitCursor = {
  persistedMessages: number;
  committedParts: number;
  turnId: string;
};

/** 持久化连续的新用户消息；审批续传不会再次提交已保存的输入。 */
export async function persistSubmittedTurn(
  session: SessionFile,
  cursor: SessionCommitCursor,
  messages: UIMessage[],
) {
  assertHistory(cursor, messages);
  const submitted: UIMessage[] = [];
  for (const message of messages.slice(cursor.persistedMessages)) {
    if (message.role !== "user") break;
    submitted.push(message);
  }
  const result = await commitSession({
    ...session,
    messages: serializeSessionMessages(submitted, {
      timestamp: new Date(session.updatedAt).toISOString(),
      turnId: cursor.turnId,
    }),
  });
  cursor.persistedMessages += submitted.length;
  return result;
}

/** 在恢复同一轮模型循环前提交完整前缀和内部事件，保持 append-only 语义。 */
export async function persistTurnCheckpoint(
  session: SessionFile,
  cursor: SessionCommitCursor,
  messages: UIMessage[],
  event: TurnEvent,
) {
  const edits = peekFileEditRuntime(session.id)?.pending();
  const usage = pendingUsage(
    session.id,
    new Date(session.updatedAt).toISOString(),
  );
  const result = await commitSession({
    ...session,
    messages: [
      ...usage,
      ...serializeSessionMessages(
        [
          ...uncommittedConversationMessages(messages, cursor.committedParts),
          {
            id: "event",
            role: "assistant",
            parts: [conversationEventPart(event)],
          },
        ],
        {
          timestamp: new Date(session.updatedAt).toISOString(),
          turnId: cursor.turnId,
          turnStatus: "running",
        },
      ),
      ...(edits?.snapshot.calls.length
        ? [
            {
              role: "display" as const,
              content: edits.snapshot,
              timestamp: new Date(session.updatedAt).toISOString(),
              turn_id: cursor.turnId,
            },
          ]
        : []),
    ],
  });
  acknowledgeUsage(session.id, usage.length);
  if (edits) peekFileEditRuntime(session.id)?.acknowledge(edits.count);
  cursor.committedParts = (messages[0]?.parts.length ?? 0) + 1;
  return result;
}

/** 提交未保存的终态与展示快照；后续解锁失败重试也不会重复追加响应。 */
export async function persistCompletedTurn(
  session: SessionFile,
  cursor: SessionCommitCursor,
  messages: UIMessage[],
  outcome: string,
  snapshots: SubagentDisplaySnapshot[],
) {
  assertHistory(cursor, messages);
  await peekFileEditRuntime(session.id)?.settled();
  const edits = peekFileEditRuntime(session.id)?.pending();
  const usage = pendingUsage(
    session.id,
    new Date(session.updatedAt).toISOString(),
  );
  const options = {
    timestamp: new Date(session.updatedAt).toISOString(),
    turnId: cursor.turnId,
    turnStatus: outcome,
  };
  const result = await commitSession({
    ...session,
    messages: [
      ...usage,
      ...serializeSessionMessages(
        uncommittedConversationMessages(
          messages.slice(cursor.persistedMessages),
          cursor.committedParts,
        ),
        options,
      ),
      ...serializeSubagentDisplaySnapshots(snapshots, options),
      ...(edits?.snapshot.calls.length
        ? [
            {
              role: "display" as const,
              content: edits.snapshot,
              timestamp: options.timestamp,
              turn_id: cursor.turnId,
            },
          ]
        : []),
    ],
  });
  acknowledgeUsage(session.id, usage.length);
  if (edits) peekFileEditRuntime(session.id)?.acknowledge(edits.count);
  settleUsage(session.id);
  cursor.persistedMessages = messages.length;
  cursor.committedParts = 0;
  return result;
}

function assertHistory(cursor: SessionCommitCursor, messages: UIMessage[]) {
  if (messages.length < cursor.persistedMessages)
    throw new Error("The UI message history is shorter than the session file");
}
