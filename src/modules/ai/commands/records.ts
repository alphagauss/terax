/** 命令调用与回执是独立会话事实，仅投影到时间线，不构造 SDK 消息。 */
import type { SessionMessage } from "@/modules/ai/lib/conversation";
export type CommandRecord = {
  id: string;
} & (
  | {
      phase: "invocation";
      input: string;
      name: string;
      afterMessageId?: string;
    }
  | {
      phase: "result";
      text: string;
      status: "success" | "error";
      taskMessageId?: string;
    }
);
export type CommandDisplay = {
  id: string;
  input: string;
  timestamp: number;
  afterMessageId?: string;
  result?: Extract<CommandRecord, { phase: "result" }>;
  pending?: "waiting" | "running";
};

export function projectCommands(
  records: readonly SessionMessage[],
): CommandDisplay[] {
  const commands = new Map<string, CommandDisplay>();
  for (const record of records) {
    if (record.role !== "command") continue;
    const content = record.content;
    if (content.phase === "invocation") {
      commands.set(content.id, {
        id: content.id,
        input: content.input,
        timestamp: Date.parse(record.timestamp),
        afterMessageId: content.afterMessageId,
      });
    } else {
      const command = commands.get(content.id);
      if (command) command.result = content;
    }
  }
  return [...commands.values()];
}
