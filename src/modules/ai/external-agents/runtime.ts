/**
 * 本文件定义 External Agent 的统一前端协议与聊天流适配。
 * CLI 只在当前 Workspace 后端运行；各 Agent parser 仅解释结构化 stdout，不参与进程管理。
 */

import { currentWorkspaceEnv } from "@/modules/workspace";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { UIMessage, UIMessageChunk } from "ai";

export type ExternalAgentId = "claude" | "codex";

export type ExternalAgentAvailability = {
  agentId: ExternalAgentId;
  installed: boolean;
};

export type ExternalAgentBinding = {
  agentId: ExternalAgentId;
  sessionId: string | null;
};

/** 从不透明会话 metadata 中读取经过边界校验的 External Agent 绑定。 */
export function parseExternalAgentBinding(
  metadata: Record<string, unknown> | undefined,
): ExternalAgentBinding | null {
  const value = metadata?.externalAgent;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const binding = value as Record<string, unknown>;
  if (binding.agentId !== "claude" && binding.agentId !== "codex") return null;
  if (binding.sessionId !== null && typeof binding.sessionId !== "string") {
    return null;
  }
  return { agentId: binding.agentId, sessionId: binding.sessionId };
}

export type ExternalAgentProcessEvent =
  | { kind: "output"; stdout: string }
  | {
      kind: "done";
      status: "running" | "exited" | "timed_out" | "terminated";
      exitCode: number | null;
      stderr: string;
    };

type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "activity"; toolName: string; input?: unknown }
  | { type: "usage"; input: number; output: number; cached: number }
  | { type: "completed" }
  | { type: "error"; message: string };

type Parser = {
  feed: (chunk: string) => AgentEvent[];
  finish: () => AgentEvent[];
};

type ExternalAgentAdapter = {
  id: ExternalAgentId;
  label: string;
  createParser: () => Parser;
};

const EXTERNAL_AGENT_ADAPTERS: Record<ExternalAgentId, ExternalAgentAdapter> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    createParser: createClaudeParser,
  },
  codex: {
    id: "codex",
    label: "Codex",
    createParser: createCodexParser,
  },
};

export const EXTERNAL_AGENTS: readonly ExternalAgentAdapter[] = Object.values(
  EXTERNAL_AGENT_ADAPTERS,
);

const MAX_JSON_LINE_LENGTH = 1024 * 1024;

/** 在当前 Local、WSL 或 SSH 环境中探测可执行的 External Agent。 */
export function listExternalAgents(): Promise<ExternalAgentAvailability[]> {
  return invoke("external_agent_list", { workspace: currentWorkspaceEnv() });
}

function createJsonlParser(
  parse: (value: Record<string, unknown>) => AgentEvent[],
): Parser {
  let pending = "";
  const consume = (final: boolean) => {
    const events: AgentEvent[] = [];
    const lines = pending.split("\n");
    pending = final ? "" : (lines.pop() ?? "");
    if (pending.length > MAX_JSON_LINE_LENGTH) {
      pending = "";
      return [
        { type: "error", message: "External Agent JSON line is too large." },
      ] as AgentEvent[];
    }
    for (const raw of lines) {
      if (raw.length > MAX_JSON_LINE_LENGTH) {
        events.push({
          type: "error",
          message: "External Agent JSON line is too large.",
        });
        continue;
      }
      const line = raw.trim();
      if (!line) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          events.push(...parse(value as Record<string, unknown>));
        }
      } catch {
        // CLI 的非协议提示可能混入 stdout；只忽略单行噪声，不截断后续事件。
      }
    }
    return events;
  };
  return {
    feed(chunk) {
      pending += chunk;
      return consume(false);
    },
    finish() {
      if (pending && !pending.endsWith("\n")) pending += "\n";
      return consume(true);
    },
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function createClaudeParser(): Parser {
  return createJsonlParser((event) => {
    const events: AgentEvent[] = [];
    const sessionId = stringValue(event.session_id);
    if (sessionId) events.push({ type: "session", sessionId });
    if (event.type === "assistant") {
      const message = event.message as
        | { content?: Array<{ type?: string; text?: string; name?: string }> }
        | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === "text" && block.text) {
          events.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          events.push({
            type: "activity",
            toolName: "external_agent_tool",
            input: { agentId: "claude", tool: block.name ?? "tool" },
          });
        }
      }
    } else if (event.type === "result") {
      if (event.is_error === true) {
        events.push({
          type: "error",
          message:
            stringValue(event.result) ?? "Claude Code returned an error.",
        });
      }
      events.push({ type: "completed" });
    }
    return events;
  });
}

function createCodexParser(): Parser {
  return createJsonlParser((event) => {
    const events: AgentEvent[] = [];
    const sessionId = stringValue(event.thread_id ?? event.session_id);
    if (sessionId) events.push({ type: "session", sessionId });
    const item = event.item as
      | { type?: string; text?: string; command?: string }
      | undefined;
    if (
      event.type === "item.completed" &&
      item?.type === "agent_message" &&
      item.text
    ) {
      events.push({ type: "text", text: item.text });
    } else if (event.type === "item.started") {
      if (item?.type === "command_execution" && item.command) {
        events.push({
          type: "activity",
          toolName: "shell_exec",
          input: { command: item.command },
        });
      } else if (item?.type === "file_change") {
        events.push({
          type: "activity",
          toolName: "external_agent_file_change",
        });
      } else if (item?.type === "reasoning") {
        events.push({ type: "activity", toolName: "external_agent_thinking" });
      } else if (item?.type === "web_search") {
        events.push({
          type: "activity",
          toolName: "external_agent_web_search",
        });
      }
    } else if (event.type === "turn.completed") {
      const usage = event.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cached_input_tokens?: number;
          }
        | undefined;
      if (usage) {
        events.push({
          type: "usage",
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cached: usage.cached_input_tokens ?? 0,
        });
      }
      events.push({ type: "completed" });
    } else if (event.type === "turn.failed" || event.type === "error") {
      const error = event.error as { message?: string } | undefined;
      events.push({
        type: "error",
        message:
          stringValue(error?.message) ??
          stringValue(event.message) ??
          "Codex returned an error.",
      });
    }
    return events;
  });
}

/** 为一个受支持的 CLI 协议创建独立增量 parser。 */
export function createExternalAgentParser(agentId: ExternalAgentId): Parser {
  return EXTERNAL_AGENT_ADAPTERS[agentId].createParser();
}

function lastUserText(messages: UIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    return message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
  }
  return "";
}

export type ExternalAgentStreamOptions = {
  agentId: ExternalAgentId;
  ownerSessionId: string;
  externalSessionId: string | null;
  cwd: string;
  permissionMode: "ask" | "full-access";
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  onSession: (sessionId: string) => void | Promise<void>;
};

/** 根据 CLI 协议终态和进程终态判断本轮是否失败。 */
export function externalAgentProcessError(
  agentId: ExternalAgentId,
  event: Extract<ExternalAgentProcessEvent, { kind: "done" }>,
  protocolCompleted: boolean,
  protocolError: string | null,
): string | undefined {
  if (protocolError) return protocolError;
  const label = EXTERNAL_AGENT_ADAPTERS[agentId].label;
  if (event.status === "terminated") return undefined;
  if (event.status === "timed_out") {
    return event.stderr.trim() || `${label} timed out.`;
  }
  if (event.status === "running") {
    return `${label} returned an invalid process state.`;
  }
  if (event.exitCode != null && event.exitCode !== 0) {
    return (
      event.stderr.trim() || `${label} exited with code ${event.exitCode}.`
    );
  }
  if (!protocolCompleted) {
    return event.stderr.trim() || `${label} ended without a completion event.`;
  }
  return undefined;
}

/** 把一次 External Agent CLI turn 转换为 AI SDK 聊天消息流。 */
export function runExternalAgentStream(
  options: ExternalAgentStreamOptions,
): ReadableStream<UIMessageChunk> {
  const latestUser = [...options.messages]
    .reverse()
    .find((message) => message.role === "user");
  if (latestUser?.parts.some((part) => part.type !== "text")) {
    throw new Error("External Agents currently support text input only.");
  }
  const prompt = lastUserText(options.messages);
  const parser = createExternalAgentParser(options.agentId);
  let processId: string | null = null;
  let sessionTask = Promise.resolve();
  let textSequence = 0;
  let toolSequence = 0;

  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      let closed = false;
      let protocolError: string | null = null;
      let protocolCompleted = false;
      let sawText = false;
      let observedSessionId = options.externalSessionId;
      let activeToolCallId: string | null = null;
      const push = (chunk: UIMessageChunk) => {
        if (!closed) controller.enqueue(chunk);
      };
      const completeActivity = () => {
        if (!activeToolCallId) return;
        push({
          type: "tool-output-available",
          toolCallId: activeToolCallId,
          output: undefined,
          dynamic: true,
        });
        activeToolCallId = null;
      };
      const pushActivity = (toolName: string, input?: unknown) => {
        completeActivity();
        const toolCallId = `external-activity-${toolSequence++}`;
        push({
          type: "tool-input-available",
          toolCallId,
          toolName,
          input,
          dynamic: true,
        });
        activeToolCallId = toolCallId;
      };
      const consume = (events: AgentEvent[]) => {
        for (const event of events) {
          if (event.type === "session") {
            if (event.sessionId === observedSessionId) continue;
            observedSessionId = event.sessionId;
            sessionTask = sessionTask.then(() =>
              options.onSession(event.sessionId),
            );
          } else if (event.type === "text") {
            completeActivity();
            const id = `external-${textSequence++}`;
            push({ type: "text-start", id });
            push({
              type: "text-delta",
              id,
              delta: sawText ? `\n\n${event.text}` : event.text,
            });
            push({ type: "text-end", id });
            sawText = true;
          } else if (event.type === "activity") {
            pushActivity(event.toolName, event.input);
          } else if (event.type === "completed") {
            completeActivity();
            protocolCompleted = true;
          } else if (event.type === "error") {
            protocolError = event.message;
          }
        }
      };
      const finish = async (error?: string) => {
        if (closed) return;
        completeActivity();
        closed = true;
        options.abortSignal?.removeEventListener("abort", onAbort);
        await sessionTask.catch((reason) => {
          error ??= reason instanceof Error ? reason.message : String(reason);
        });
        if (error) controller.enqueue({ type: "error", errorText: error });
        controller.enqueue({ type: "finish" });
        controller.close();
      };
      const cancel = () => {
        if (!processId) return;
        void invoke("external_agent_cancel", {
          ownerSessionId: options.ownerSessionId,
          processId,
          workspace: currentWorkspaceEnv(),
        }).catch(() => undefined);
      };
      const onAbort = () => {
        cancel();
        void finish();
      };
      options.abortSignal?.addEventListener("abort", onAbort, { once: true });

      push({ type: "start" });
      pushActivity("external_agent_start", {
        agentId: options.agentId,
      });
      const channel = new Channel<ExternalAgentProcessEvent>();
      channel.onmessage = (event) => {
        if (closed) return;
        if (event.kind === "output") {
          consume(parser.feed(event.stdout));
          return;
        }
        consume(parser.finish());
        const error = externalAgentProcessError(
          options.agentId,
          event,
          protocolCompleted,
          protocolError,
        );
        void finish(error);
      };

      try {
        processId = await invoke<string>("external_agent_run", {
          ownerSessionId: options.ownerSessionId,
          agentId: options.agentId,
          prompt,
          externalSessionId: options.externalSessionId,
          cwd: options.cwd,
          permissionMode: options.permissionMode,
          workspace: currentWorkspaceEnv(),
          onEvent: channel,
        });
        if (options.abortSignal?.aborted || closed) cancel();
      } catch (error) {
        await finish(error instanceof Error ? error.message : String(error));
      }
    },
    cancel() {
      if (!processId) return;
      void invoke("external_agent_cancel", {
        ownerSessionId: options.ownerSessionId,
        processId,
        workspace: currentWorkspaceEnv(),
      }).catch(() => undefined);
    },
  });
}
