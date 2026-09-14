/** 命令先保存调用再执行；提交确认与完成结果分开，桌面和 Channel 共用同一入口。 */
import i18n from "@/i18n";
import type { UIMessage } from "ai";
import {
  resolveCommand,
  type CommandSource,
  type ParsedCommand,
} from "@/modules/ai/commands/registry";
import type {
  CommandDisplay,
  CommandRecord,
} from "@/modules/ai/commands/records";
import { projectConversationDisplay } from "@/modules/ai/lib/conversation";
import {
  appendSessionCommand,
  chats,
  seedMessages,
  seedSession,
  getAgentMetaForSession,
  releaseUnusedChats,
  useChatStore,
} from "@/modules/ai/store/chatStore";

type CommandRequest = {
  sessionId: string;
  command: ParsedCommand;
  source: CommandSource;
  channelId?: string;
  hasAttachments?: boolean;
  signal?: AbortSignal;
  startTask: (message: UIMessage) => Promise<boolean>;
};
type CommandResult = Extract<CommandRecord, { phase: "result" }>;
const idleCommands = new Map<string, Promise<void>>();

/** 等待已有 Agent 释放锁，保存失败和取消均结束等待。 */
async function waitForIdle(id: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!useChatStore.getState().runLockSessionIds[id]) return;
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      const state = useChatStore.getState();
      const error = getAgentMetaForSession(state, id).commitError;
      if (!signal?.aborted && !error && state.runLockSessionIds[id]) return;
      unsubscribe();
      signal?.removeEventListener("abort", check);
      if (signal?.aborted || error) reject(signal?.reason ?? new Error(error));
      else resolve();
    };
    const unsubscribe = useChatStore.subscribe(check);
    signal?.addEventListener("abort", check, { once: true });
    check();
  });
}

/** 调用落盘后返回接收确认；空闲命令按序执行，即时命令不进入该队列。 */
export async function submitSessionCommand(
  request: CommandRequest,
): Promise<{ completed: Promise<CommandResult> }> {
  const { sessionId, command, signal } = request;
  const t = (key: string, values?: Record<string, string>) =>
    String(i18n.t(`ai:${key}`, values));
  if (
    !chats.has(sessionId) &&
    !seedMessages.has(sessionId) &&
    useChatStore.getState().sessions.some((item) => item.id === sessionId)
  )
    await seedSession(sessionId);
  const sourceMessages =
    chats.get(sessionId)?.messages ?? seedMessages.get(sessionId) ?? [];
  if (getAgentMetaForSession(useChatStore.getState(), sessionId).commitError) {
    await useChatStore.getState().commitMessages(sessionId, sourceMessages);
  }
  signal?.throwIfAborted();
  const messages = projectConversationDisplay(sourceMessages);
  const idle = command.definition?.scheduling === "idle";
  let wasWaiting =
    idle &&
    Boolean(
      idleCommands.has(sessionId) ||
        useChatStore.getState().runLockSessionIds[sessionId],
    );
  const display: CommandDisplay = {
    id: crypto.randomUUID(),
    input: command.raw,
    timestamp: Date.now(),
    afterMessageId: messages[messages.length - 1]?.id,
    pending: wasWaiting ? "waiting" : "running",
  };
  await appendSessionCommand(
    sessionId,
    {
      id: display.id,
      phase: "invocation",
      input: display.input,
      name: command.definition?.name ?? command.name,
      afterMessageId: display.afterMessageId,
    },
    display,
    request.channelId,
  );

  wasWaiting ||= idle && idleCommands.has(sessionId);
  const execute = async (): Promise<CommandResult> => {
    let reply: Omit<CommandResult, "id" | "phase">;
    try {
      if (idle) await waitForIdle(sessionId, signal);
      const cancelled =
        wasWaiting &&
        getAgentMetaForSession(useChatStore.getState(), sessionId).cancelled;
      signal?.throwIfAborted();
      if (cancelled) reply = { text: t("commands.cancelled"), status: "error" };
      else {
        const outcome = await resolveCommand(
          command,
          { sessionId, source: request.source, t, signal },
          request.hasAttachments,
        );
        if (outcome.kind === "reply")
          reply = {
            text: outcome.text,
            status: outcome.error ? "error" : "success",
          };
        else {
          const id = crypto.randomUUID();
          const started = await request.startTask({
            id,
            role: "user",
            parts: [{ type: "text", text: outcome.prompt }],
            metadata: { createdAt: Date.now(), commandId: display.id },
          });
          reply = started
            ? {
                text: t("commands.taskAccepted"),
                status: "success",
                taskMessageId: id,
              }
            : { text: t("commands.taskRejected"), status: "error" };
        }
      }
    } catch (error) {
      if (
        getAgentMetaForSession(useChatStore.getState(), sessionId).commitError
      )
        throw error;
      reply = {
        text: t(
          signal?.aborted ? "commands.cancelled" : "commands.executionFailed",
        ),
        status: "error",
      };
    }
    const result: CommandResult = { id: display.id, phase: "result", ...reply };
    await appendSessionCommand(
      sessionId,
      result,
      { ...display, pending: undefined, result },
      request.channelId,
    );
    return result;
  };
  const completed = (
    idle
      ? (idleCommands.get(sessionId) ?? Promise.resolve())
      : Promise.resolve()
  ).then(execute);
  const settled = completed.then(
    () => undefined,
    () => {
      display.pending = undefined;
    },
  );
  if (idle) idleCommands.set(sessionId, settled);
  void settled.then(() => {
    if (idleCommands.get(sessionId) === settled) idleCommands.delete(sessionId);
    releaseUnusedChats();
  });
  return { completed };
}
