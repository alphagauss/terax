/** 命令先保存调用再执行；提交确认与完成结果分开，桌面和 Channel 共用同一入口。 */
import i18n from "@/i18n";
import {
  useCommandStore,
  isCommandActive,
  updateCommand,
} from "@/modules/ai/commands/store";
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
  startCompaction?: (signal: AbortSignal) => Promise<boolean>;
  startTask: (message: UIMessage, signal: AbortSignal) => Promise<boolean>;
};
type CommandResult = Extract<CommandRecord, { phase: "result" }>;

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

/** 接收时同步占用命令入口，持久化完成才释放；等待和执行共用取消信号。 */
export async function submitSessionCommand(
  request: CommandRequest,
): Promise<{ completed: Promise<CommandResult> }> {
  const { sessionId } = request;
  if (
    isCommandActive(sessionId) ||
    getAgentMetaForSession(useChatStore.getState(), sessionId).compacting
  )
    throw new Error(i18n.t("ai:commands.busy"));
  const controller = new AbortController();
  useCommandStore.setState((state) => ({
    active: { ...state.active, [sessionId]: controller },
  }));
  const release = () => {
    useCommandStore.setState((state) => {
      const active = { ...state.active };
      delete active[sessionId];
      return { active };
    });
    releaseUnusedChats();
  };
  try {
    const receipt = await executeSessionCommand({
      ...request,
      signal: request.signal
        ? AbortSignal.any([request.signal, controller.signal])
        : controller.signal,
    });
    return { completed: receipt.completed.finally(release) };
  } catch (error) {
    release();
    throw error;
  }
}

async function executeSessionCommand(
  request: CommandRequest & { signal: AbortSignal },
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
  const wasWaiting =
    idle && Boolean(useChatStore.getState().runLockSessionIds[sessionId]);
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

  const execute = async (): Promise<CommandResult> => {
    let reply: Omit<CommandResult, "id" | "phase">;
    try {
      signal.throwIfAborted();
      const outcome = await resolveCommand(
        command,
        { sessionId, source: request.source, t, signal },
        request.hasAttachments,
      );
      if (idle && outcome.kind !== "reply")
        await waitForIdle(sessionId, signal);
      signal.throwIfAborted();
      updateCommand(sessionId, { ...display, pending: "running" });
      if (outcome.kind === "reply")
        reply = {
          text: outcome.text,
          status: outcome.error ? "error" : "success",
        };
      else if (outcome.kind === "compact") {
        if (!request.startCompaction)
          throw new Error("Compaction is unavailable");
        const compacted = await request.startCompaction(signal);
        reply = {
          text: t(
            compacted ? "commands.compacted" : "commands.nothingToCompact",
          ),
          status: "success",
        };
      } else {
        const id = crypto.randomUUID();
        const started = await request.startTask(
          {
            id,
            role: "user",
            parts: [{ type: "text", text: outcome.prompt }],
            metadata: { createdAt: Date.now(), commandId: display.id },
          },
          signal,
        );
        reply = started
          ? {
              text: t("commands.taskAccepted"),
              status: "success",
              taskMessageId: id,
            }
          : { text: t("commands.taskRejected"), status: "error" };
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
  return {
    completed: execute().catch((error) => {
      const current = useCommandStore
        .getState()
        .sessions[sessionId]?.find((item) => item.id === display.id);
      if (current?.pending)
        updateCommand(sessionId, { ...current, pending: undefined });
      throw error;
    }),
  };
}
