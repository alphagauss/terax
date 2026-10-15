/**
 * 本文件提供不依赖界面的单会话 Agent 控制器。
 * 宿主显式注入配置，执行、审批、增量提交和取消复用桌面同一套业务实现。
 */

import {
  peekFileEditRuntime,
  releaseFileEditRuntime,
} from "@/modules/ai/lib/fileEditRuntime";
import { readAgentConfiguration } from "./agentConfiguration";
import { Chat } from "@ai-sdk/react";
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ChatTransport,
  type UIMessage,
} from "ai";
import {
  clearAgentTurnCoordinator,
  getAgentTurnCoordinator,
} from "@/modules/ai/agents/subagentRuntime";
import {
  toSubagentDisplaySnapshot,
  type SubagentDisplayState,
} from "@/modules/ai/agents/subagentDisplay";
import {
  MAIN_AGENT,
  parseSessionAgent,
  snapshotAgent,
} from "@/modules/ai/lib/agentDefinition";
import {
  materializeSubagentDisplayParts,
  materializeFileEditParts,
  materializeTurnMetadata,
  projectSessionMessages,
  materializeRunFailure,
} from "@/modules/ai/lib/conversation";
import {
  cancelAgentRun,
  observeAgentRun,
  type PendingApproval,
  type RunStatus,
} from "@/modules/ai/lib/runLifecycle";
import {
  persistSubmittedTurn,
  persistTurnCheckpoint,
  persistCompletedTurn,
  type SessionCommitCursor,
} from "@/modules/ai/lib/sessionPersistence";
import {
  acquireSessionRun,
  deriveTitle,
  newSessionId,
  readSession,
  releaseSessionRun,
  type SessionFile,
} from "@/modules/ai/lib/sessions";
import {
  createSessionTransport,
  type SessionTransportDependencies,
} from "@/modules/ai/lib/transport";
import {
  clearTerminalFileMutations,
  clearSessionFileMutations,
  prepareFileMutation,
  type PreparedFileMutation,
} from "@/modules/ai/tools/fileMutation";
import { releaseUsage, restoreUsage } from "@/modules/ai/lib/usageRuntime";

type Configuration = Pick<
  SessionTransportDependencies,
  | "getKeys"
  | "getModel"
  | "getEnvironment"
  | "getCustomInstructions"
  | "getDefaultSubagentModel"
  | "getMaxConcurrentSubagents"
  | "getMaxAgentSteps"
  | "getMaxSubagentSteps"
  | "getProviderBaseURLs"
  | "getProviderModels"
  | "getCustomProviders"
  | "getProviderInstanceKeys"
>;

export type SessionApproval = PendingApproval & {
  preview?: PreparedFileMutation;
  error?: string;
};
export type AgentSessionSnapshot = {
  messages: UIMessage[];
  status: RunStatus;
  owned: boolean;
  approvals: SessionApproval[];
  error: string | null;
  commitFailed: boolean;
};

/** 创建或恢复当前本地环境的会话，历史 cwd 和 Agent 身份保持不变。 */
export async function createAgentSession(options: {
  cwd: string;
  sessionId?: string;
  permissionMode: "ask" | "full-access";
  configuration: Configuration;
}) {
  const now = Date.now();
  let session: SessionFile = options.sessionId
    ? await readSession(options.sessionId)
    : {
        id: newSessionId(),
        createdAt: now,
        updatedAt: now,
        environmentKey: "local",
        cwd: options.cwd,
        metadata: { title: "New chat", agent: snapshotAgent(MAIN_AGENT) },
        messages: [],
      };
  if (
    session.environmentKey !== "local" ||
    session.metadata.channelId ||
    session.metadata.externalAgent
  ) {
    throw new Error(
      "This session cannot be continued by the local built-in Agent",
    );
  }
  restoreUsage(session.id, session.messages);
  const initial = projectSessionMessages(session.id, session.messages);
  let persisted = Boolean(options.sessionId);
  let cursor: SessionCommitCursor = {
    persistedMessages: initial.length,
    committedParts: 0,
    turnId: "",
  };
  let snapshot: AgentSessionSnapshot = {
    messages: initial,
    status: "idle",
    owned: false,
    approvals: [],
    error: null,
    commitFailed: false,
  };
  let lifecycle: ReturnType<typeof observeAgentRun> | undefined;
  let cancelling = false;
  let starting = false;
  let committing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const displays = new Map<string, SubagentDisplayState>();
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<AgentSessionSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const record = () => ({ ...session, updatedAt: Date.now(), messages: [] });
  const transport = createSessionTransport({
    ...options.configuration,
    getAgent: () =>
      readAgentConfiguration(parseSessionAgent(session.metadata.agent).id),
    getTurnId: () => cursor.turnId,
    getCwd: () => session.cwd,
    toolContext: {
      getCwd: () => session.cwd,
      getSessionId: () => session.id,
      getPermissionMode: () => options.permissionMode,
      supportsApprovals: true,
      getTerminalContext: () => null,
      isActiveTerminalPrivate: () => false,
    },
    onSystemPrompt: async (systemPrompt, messages) => {
      session = {
        ...session,
        metadata: {
          ...session.metadata,
          systemPrompt,
          title: deriveTitle(messages),
        },
      };
      await persistSubmittedTurn(record(), cursor, messages);
      persisted = true;
    },
    onCheckpoint: async (messages, event) => {
      await persistTurnCheckpoint(record(), cursor, messages, event);
    },
    onSubagentDisplay: (state) => {
      displays.set(state.taskId, state);
    },
  });
  const chat = new Chat<UIMessage>({
    id: session.id,
    messages: initial,
    transport: transport as ChatTransport<UIMessage>,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (error) => {
      void clearAgentTurnCoordinator(session.id);
      publish({ error: error.message });
    },
  });

  const finish = async (messages: UIMessage[]) => {
    if (committing) return committing;
    committing = (async () => {
      const outcome = cancelling
        ? "cancelled"
        : chat.status === "error"
          ? "error"
          : "completed";
      const savedDisplays = [...displays.values()].map((display) =>
        toSubagentDisplaySnapshot(
          display,
          cancelling ? "cancelled" : "failed",
          Date.now(),
        ),
      );
      if (outcome === "error") {
        messages = materializeRunFailure(
          materializeTurnMetadata(messages, cursor.turnId),
          cursor.turnId,
          chat.error,
          Date.now(),
        );
        chat.messages = messages;
      }
      await persistCompletedTurn(
        record(),
        cursor,
        messages,
        outcome,
      );
      persisted = true;
      if (savedDisplays.length)
        chat.messages = materializeSubagentDisplayParts(
          chat.messages,
          savedDisplays,
        );
      chat.messages = materializeFileEditParts(
        chat.messages,
        peekFileEditRuntime(session.id)?.snapshot(),
        cursor.turnId,
      );
      chat.messages = materializeTurnMetadata(chat.messages, cursor.turnId);
      releaseFileEditRuntime(session.id);
      displays.clear();
      clearSessionFileMutations(session.id, chat.messages);
      await releaseSessionRun(session.id);
      releaseUsage(session.id);
      lifecycle?.dispose();
      lifecycle = undefined;
      publish({
        owned: false,
        approvals: [],
        messages: chat.messages,
        commitFailed: false,
        error: chat.error?.message ?? null,
      });
    })();
    try {
      await committing;
    } finally {
      committing = undefined;
    }
  };

  return {
    id: session.id,
    cwd: session.cwd,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** 接受新一轮输入；运行中输入由调用端保留草稿，不并发启动第二轮。 */
    async send(text: string) {
      if (snapshot.owned || starting || !text.trim()) return;
      starting = true;
      try {
        if (!(await acquireSessionRun(session.id)))
          throw new Error("Session is already running in another process");
        if (persisted) {
          try {
            // 空闲期间另一个客户端可能完成一轮；持锁后重新读取，避免用过期历史继续会话。
            session = await readSession(session.id);
            restoreUsage(session.id, session.messages);
            chat.messages = projectSessionMessages(
              session.id,
              session.messages,
            );
            cursor.persistedMessages = chat.messages.length;
          } catch (error) {
            await releaseSessionRun(session.id);
            throw error;
          }
        }
        cancelling = false;
        cursor = {
          ...cursor,
          turnId: `turn_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
          committedParts: 0,
        };
        publish({ owned: true, error: null, commitFailed: false });
        lifecycle = observeAgentRun(chat, {
          sessionId: session.id,
          isOwned: () => snapshot.owned,
          onStatus: (status) => publish({ status }),
          onMessages: (messages) => {
            clearTerminalFileMutations(session.id, messages);
            publish({ messages });
          },
          onApprovals: (approvals) => {
            publish({ approvals });
            for (const request of approvals) {
              if (
                request.toolName !== "write_file" &&
                request.toolName !== "apply_patch"
              )
                continue;
              void prepareFileMutation({
                sessionId: session.id,
                toolCallId: request.toolCallId,
                toolName: request.toolName,
                input: request.input,
                cwd: session.cwd,
                permissionMode: "full-access",
              })
                .then((preview) =>
                  publish({
                    approvals: snapshot.approvals.map((item) =>
                      item.approvalId === request.approvalId
                        ? { ...item, preview }
                        : item,
                    ),
                  }),
                )
                .catch((error: unknown) =>
                  publish({
                    approvals: snapshot.approvals.map((item) =>
                      item.approvalId === request.approvalId
                        ? { ...item, error: String(error) }
                        : item,
                    ),
                  }),
                );
            }
          },
          commit: finish,
          onError: (error) =>
            publish({ error: String(error), commitFailed: true }),
        });
        getAgentTurnCoordinator(session.id).inbox.open();
        void chat.sendMessage({ text });
      } finally {
        starting = false;
      }
    },
    /** 同一次审批只回答一次，文件修改必须先取得可审阅的完整预览。 */
    async respond(approvalId: string, approved: boolean) {
      const request = snapshot.approvals.find(
        (item) => item.approvalId === approvalId,
      );
      if (!request || !lifecycle) return;
      if (
        approved &&
        (request.toolName === "write_file" ||
          request.toolName === "apply_patch") &&
        (!request.preview || request.error)
      )
        return;
      publish({
        approvals: snapshot.approvals.filter((item) => item !== request),
      });
      await lifecycle.respond(approvalId, approved);
    },
    /** 中止运行并清理登记进程；审批中的调用记为拒绝，不会自动恢复执行。 */
    async stop() {
      if (committing) return committing;
      if (stopping) return stopping;
      if (!snapshot.owned || snapshot.commitFailed) return;
      stopping = (async () => {
        cancelling = true;
        lifecycle?.dispose();
        lifecycle = undefined;
        await cancelAgentRun(chat, session.id);
        try {
          await finish(chat.messages);
          publish({ status: "idle" });
        } catch (error) {
          publish({ error: String(error), commitFailed: true });
          throw error;
        }
      })();
      try {
        await stopping;
      } finally {
        stopping = undefined;
      }
    },
    /** 保存失败时允许显式重试，沿用已成功提交的位置。 */
    async retrySave() {
      if (!snapshot.owned || !snapshot.commitFailed) return;
      await finish(chat.messages);
    },
  };
}

export type AgentSession = Awaited<ReturnType<typeof createAgentSession>>;
