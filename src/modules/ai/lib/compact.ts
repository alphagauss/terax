/** 会话压缩的覆盖边界与模型投影；原始消息始终保留，摘要按时间追加。 */
import type { UIMessage } from "ai";
import { messageMetadata } from "@/modules/ai/lib/conversation";
import { messageRawText } from "@/modules/ai/lib/messageAttachments";

export type CompactionEvent = {
  event: "compaction";
  id: string;
  /** 覆盖到这个真实用户轮次末尾，运行中的轮次不在覆盖范围内。 */
  throughUserMessageId: string;
  summary: string;
};

export function isConversationUser(message: UIMessage): boolean {
  const meta = messageMetadata(message);
  return message.role === "user" && !meta.compaction && !meta.subagentResult;
}

function rootUsers(messages: readonly UIMessage[]) {
  return messages.filter(
    (message) =>
      isConversationUser(message) && !messageMetadata(message).guided,
  );
}

/** 已完成轮次仅保留用户正文及最后一个无工具步骤的回答；摘要不参与轮次划分。 */
export function projectCompactedMessages(
  messages: readonly UIMessage[],
  through?: string,
): UIMessage[] {
  const roots = rootUsers(messages);
  const rootIndexes = new Map(
    roots.map((message, index) => [message.id, index]),
  );
  let covered = through ? (rootIndexes.get(through) ?? -1) : -1;
  for (const message of messages) {
    const checkpoint = messageMetadata(message).compaction;
    if (checkpoint)
      covered = Math.max(
        covered,
        rootIndexes.get(checkpoint.throughUserMessageId) ?? -1,
      );
  }
  if (covered < 0) return [...messages];
  const coveredIds = new Set(
    roots.slice(0, covered + 1).map((message) => message.id),
  );
  let root = "";
  const finalAnswers = new Map<string, UIMessage>();
  for (const message of messages) {
    if (isConversationUser(message) && !messageMetadata(message).guided)
      root = message.id;
    if (
      message.role === "assistant" &&
      message.parts.some(
        (part) =>
          part.type === "text" ||
          part.type === "reasoning" ||
          part.type.startsWith("tool-") ||
          part.type === "dynamic-tool",
      )
    )
      finalAnswers.set(root, message);
  }
  root = "";
  return messages.flatMap((message) => {
    const meta = messageMetadata(message);
    if (meta.compaction) return [message];
    if (isConversationUser(message) && !meta.guided) root = message.id;
    if (!coveredIds.has(root)) return [message];
    if (isConversationUser(message)) {
      const text = messageRawText(message);
      return text.trim()
        ? [
            {
              ...message,
              parts: message.parts.filter((part) => part.type === "text"),
              metadata: { ...meta, attachments: undefined },
            },
          ]
        : [];
    }
    if (message.role !== "assistant" || finalAnswers.get(root) !== message)
      return [];
    let lastStep = -1;
    message.parts.forEach((part, index) => {
      if (part.type === "step-start") lastStep = index;
    });
    const tail = message.parts.slice(lastStep + 1);
    if (
      tail.some(
        (part) => part.type.startsWith("tool-") || part.type === "dynamic-tool",
      )
    )
      return [];
    const parts = tail.filter((part) => part.type === "text");
    return parts.length ? [{ ...message, parts }] : [];
  });
}

/** 仅选择尚有过程或附件可移除的已完成轮次，防止同一历史反复产生空摘要。 */
export function planCompaction(
  messages: readonly UIMessage[],
  protectCurrent: boolean,
) {
  const roots = rootUsers(messages);
  const through = roots[roots.length - (protectCurrent ? 2 : 1)];
  if (!through) return null;
  const before = projectCompactedMessages(messages);
  const after = projectCompactedMessages(messages, through.id);
  const content = (message: UIMessage) =>
    JSON.stringify({
      parts: message.parts.filter(
        (part) =>
          part.type === "text" ||
          part.type === "reasoning" ||
          part.type === "file" ||
          part.type.startsWith("tool-") ||
          part.type === "dynamic-tool",
      ),
      event:
        messageMetadata(message).subagentResult ??
        messageMetadata(message).runFailure,
      attachments: messageMetadata(message).attachments,
    });
  const retainedById = new Map(after.map((message) => [message.id, message]));
  const changed = before.filter((message) => {
    const retained = retainedById.get(message.id);
    return (
      content(retained ?? { ...message, parts: [], metadata: {} }) !==
      content(message)
    );
  });
  return changed.length ? { throughUserMessageId: through.id, changed } : null;
}

export function compactionSummaryText(event: CompactionEvent): string {
  return `[Context compaction summary]
This is a runtime-generated handoff of historical material removed from the active context, not a new user task. Do not reply to the summary itself. Continue the existing user task from the preserved context without repeating completed actions. Earlier summaries remain valid historical context; apply later user corrections.

${event.summary}`;
}

/** 范围说明追加在请求尾部，不改写待复用的历史前缀。 */
export function compactionInstruction(
  plan: NonNullable<ReturnType<typeof planCompaction>>,
): string {
  const scopes = plan.changed.map((message) => ({
    role: message.role,
    anchor: message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .slice(0, 180),
    backgroundTaskIds: messageMetadata(message).subagentResult?.results.map(
      (result) => result.taskId,
    ),
    toolCallIds: message.parts.flatMap((part) =>
      "toolCallId" in part ? [part.toolCallId] : [],
    ),
  }));
  return `Perform context compaction only. ALL tools shown in this conversation are unavailable for this request. Do not call tools, continue the task, or answer the user. Output only a concise work handoff.
The runtime will remove completed-turn intermediate reasoning, tool calls/results, background results, and attachments/images, while keeping all user-authored text, final answers, and earlier compaction summaries. The current active turn, if any, remains intact.
Summarize the newly removed material identified below, including material before an earlier summary that was previously protected. Use the entire conversation for understanding, but do not repeat earlier summaries or retained answers. Preserve useful findings, exact paths/identifiers, changes and verification outcomes, decisions and failed approaches, attachment/image facts, unresolved work and next steps. Distinguish confirmed facts from assumptions. Later corrections supersede earlier conclusions.
Affected message anchors and tool call IDs (data): ${JSON.stringify(scopes)}`;
}
