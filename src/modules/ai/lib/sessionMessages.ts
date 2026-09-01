/**
 * 本文件定义与具体 AI SDK 无关的会话消息记录，并负责与 UIMessage 双向转换。
 * 工具调用使用 OpenAI function envelope，内部 Subagent 事件保持 append-only 顺序。
 */

import type { UIMessage } from "@ai-sdk/react";
import {
  formatSubagentResultEvent,
  isSubagentResultDataPart,
  isSubagentResultEvent,
  type SubagentResultEvent,
} from "../agents/subagentRuntime";

/** OpenAI-compatible function envelope 中的单次工具调用。 */
export type SessionToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

/** 用户消息所附带的媒体引用。 */
export type SessionMedia = {
  media_type: string;
  url: string;
  filename?: string;
};

/** JSONL 中除首行以外的一条开放式角色消息记录。 */
export type SessionMessage = {
  role: string;
  content: unknown;
  timestamp: string;
  turn_id?: string;
  injected_event?: "subagent_result";
  subagent_task_ids?: string[];
  subagent_result?: SubagentResultEvent;
  media?: SessionMedia[];
  reasoning_content?: string;
  tool_calls?: SessionToolCall[];
  turn_status?: string;
  tool_call_id?: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
};

type AppendOptions = {
  timestamp: string;
  turnId: string;
  turnStatus?: string;
};

type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: {
    id: string;
    approved: boolean;
    reason?: string;
  };
};

type AssistantBlock = {
  content: string[];
  reasoning: string[];
  tools: ToolPart[];
};

/**
 * 将持久化记录投影为 AI SDK UIMessage。
 *
 * 多条 assistant 和 tool 记录会合并为一个 UI assistant 消息，并用 step-start
 * 保留模型调用步骤。生成的消息 ID 只用于当前 UI，磁盘记录不依赖 SDK ID。
 */
export function projectSessionMessages(
  sessionId: string,
  records: readonly SessionMessage[],
): UIMessage[] {
  const messages: UIMessage[] = [];
  let assistantParts: UIMessage["parts"] | null = null;
  let assistantStart = -1;
  let assistantTurnId: string | undefined;
  let assistantTimestamp: number | undefined;

  const flushAssistant = () => {
    if (!assistantParts) return;
    messages.push({
      id: `${sessionId}:assistant:${assistantStart}`,
      role: "assistant",
      parts: assistantParts,
      ...(assistantTimestamp === undefined
        ? {}
        : { metadata: { createdAt: assistantTimestamp } }),
    });
    assistantParts = null;
    assistantStart = -1;
    assistantTurnId = undefined;
    assistantTimestamp = undefined;
  };

  const ensureAssistant = (
    index: number,
    turnId: string | undefined,
    timestamp: number | undefined,
  ): UIMessage["parts"] => {
    if (
      assistantParts &&
      assistantTurnId &&
      turnId &&
      assistantTurnId !== turnId
    ) {
      flushAssistant();
    }
    if (!assistantParts) {
      assistantParts = [];
      assistantStart = index;
      assistantTurnId = turnId;
      assistantTimestamp = timestamp;
    }
    return assistantParts;
  };

  records.forEach((record, index) => {
    const timestamp = parseRecordedTimestamp(record.timestamp);
    if (
      record.role === "user" &&
      record.injected_event === "subagent_result" &&
      isSubagentResultEvent(record.subagent_result) &&
      record.content === formatSubagentResultEvent(record.subagent_result)
    ) {
      const parts = ensureAssistant(index, record.turn_id, timestamp);
      parts.push({
        type: "data-subagent-result",
        data: { event: record.subagent_result },
      } as UIMessage["parts"][number]);
      return;
    }
    if (record.role === "user" || record.role === "system") {
      flushAssistant();
      const content =
        typeof record.content === "string"
          ? record.content
          : JSON.stringify(record.content);
      const parts: UIMessage["parts"] = content
        ? [{ type: "text", text: content }]
        : [];
      for (const media of record.media ?? []) {
        parts.push({
          type: "file",
          mediaType: media.media_type,
          url: media.url,
          filename: media.filename,
        });
      }
      messages.push({
        id: `${sessionId}:${record.role}:${index}`,
        role: record.role,
        parts,
        ...(timestamp === undefined
          ? {}
          : { metadata: { createdAt: timestamp } }),
      });
      return;
    }

    if (record.role !== "assistant" && record.role !== "tool") return;
    const parts = ensureAssistant(index, record.turn_id, timestamp);
    if (record.role === "assistant") {
      // 一轮中可能先请求工具再给出最终答复，消息底部应显示最后一段答复的时间。
      if (timestamp !== undefined) assistantTimestamp = timestamp;
      parts.push({ type: "step-start" });
      if (record.reasoning_content) {
        parts.push({
          type: "reasoning",
          text: record.reasoning_content,
          state: "done",
        });
      }
      for (const call of record.tool_calls ?? []) {
        parts.push({
          type: `tool-${call.function.name}`,
          toolCallId: call.id,
          state: "input-available",
          input: parseToolArguments(call.function.arguments),
        } as UIMessage["parts"][number]);
      }
      if (typeof record.content === "string" && record.content) {
        parts.push({ type: "text", text: record.content, state: "done" });
      }
      return;
    }

    if (!record.tool_call_id) return;
    const toolIndex = parts.findIndex(
      (part) => "toolCallId" in part && part.toolCallId === record.tool_call_id,
    );
    if (toolIndex < 0) return;
    const tool = parts[toolIndex] as ToolPart;
    const resultText =
      typeof record.content === "string"
        ? record.content
        : JSON.stringify(record.content);
    parts[toolIndex] = (
      record.status === "denied"
        ? {
            ...tool,
            state: "output-denied",
            approval: {
              id: `persisted:${record.tool_call_id}`,
              approved: false,
              reason: resultText,
            },
          }
        : record.status === "error"
          ? {
              ...tool,
              state: "output-error",
              errorText: resultText,
            }
          : {
              ...tool,
              state: "output-available",
              output: record.content,
            }
    ) as UIMessage["parts"][number];
  });

  flushAssistant();
  return messages;
}

/** 将一组新增 UIMessage 转换为可追加的会话记录。 */
export function serializeSessionMessages(
  messages: readonly UIMessage[],
  options: AppendOptions,
): SessionMessage[] {
  return messages.flatMap((message) => serializeUiMessage(message, options));
}

/** 将单条 UIMessage 拆成一组按角色排列的会话记录。 */
function serializeUiMessage(
  message: UIMessage,
  options: AppendOptions,
): SessionMessage[] {
  const messageOptions = {
    ...options,
    timestamp: timestampFromMessage(message, options.timestamp),
  };
  if (message.role === "user" || message.role === "system") {
    const content = message.parts
      .filter(
        (part): part is Extract<typeof part, { type: "text" }> =>
          part.type === "text",
      )
      .map((part) => part.text)
      .join("");
    const media = message.parts
      .filter(
        (part): part is Extract<typeof part, { type: "file" }> =>
          part.type === "file",
      )
      .map((part) => ({
        media_type: part.mediaType,
        url: part.url,
        ...(part.filename ? { filename: part.filename } : {}),
      }));
    return [
      {
        role: message.role,
        content,
        timestamp: messageOptions.timestamp,
        turn_id: messageOptions.turnId,
        ...(media.length > 0 ? { media } : {}),
      },
    ];
  }

  const records = serializeAssistantMessage(message, messageOptions);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.role !== "assistant") continue;
    record.turn_status = options.turnStatus ?? "completed";
    break;
  }
  return records;
}

/** 跳过最后一个内部事件之前已经 checkpoint 的 Assistant 前缀。 */
function serializeAssistantMessage(
  message: UIMessage,
  options: AppendOptions,
): SessionMessage[] {
  let lastCheckpoint = -1;
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (isSubagentResultDataPart(part)) {
      lastCheckpoint = index;
      break;
    }
  }
  return splitAssistantBlocks({
    ...message,
    parts: message.parts.slice(lastCheckpoint + 1),
  }).flatMap((block) => serializeAssistantBlock(block, options));
}

/** 将内部 Subagent 事件保存为 provider 通用的隐藏 user 记录。 */
export function serializeSubagentResultEvent(
  event: SubagentResultEvent,
  options: AppendOptions,
): SessionMessage {
  return {
    role: "user",
    content: formatSubagentResultEvent(event),
    timestamp: options.timestamp,
    turn_id: options.turnId,
    injected_event: "subagent_result",
    subagent_task_ids: event.results.map((result) => result.taskId),
    subagent_result: event,
  };
}

/** 从 UI 消息元数据读取创建时间，缺失或非法时使用本次提交时间。 */
function timestampFromMessage(message: UIMessage, fallback: string): string {
  const createdAt = (message.metadata as { createdAt?: unknown } | undefined)
    ?.createdAt;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return fallback;
  }
  return new Date(createdAt).toISOString();
}

/** 容忍旧会话中异常时间戳，避免单条坏记录阻断整段会话恢复。 */
function parseRecordedTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** 按 step-start 切分 assistant 内容，保持模型步骤与工具结果的先后关系。 */
function splitAssistantBlocks(message: UIMessage): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  let current: AssistantBlock = {
    content: [],
    reasoning: [],
    tools: [],
  };

  const flush = () => {
    if (
      current.content.length > 0 ||
      current.reasoning.length > 0 ||
      current.tools.length > 0
    ) {
      blocks.push(current);
    }
    current = { content: [], reasoning: [], tools: [] };
  };

  for (const part of message.parts) {
    if (part.type === "step-start") {
      flush();
    } else if (part.type === "text") {
      current.content.push(part.text);
    } else if (part.type === "reasoning") {
      current.reasoning.push(part.text);
    } else if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      current.tools.push(part as ToolPart);
    }
  }
  flush();
  return blocks.length > 0
    ? blocks
    : [{ content: [""], reasoning: [], tools: [] }];
}

/** 将一个 assistant 步骤写成 assistant 记录及其紧随的 tool 结果记录。 */
function serializeAssistantBlock(
  block: AssistantBlock,
  options: AppendOptions,
): SessionMessage[] {
  const toolCalls = block.tools.map((tool) => ({
    id: tool.toolCallId,
    type: "function" as const,
    function: {
      name: toolName(tool),
      arguments: stringifyToolArguments(tool.input),
    },
  }));
  const assistant: SessionMessage = {
    role: "assistant",
    content: block.content.join(""),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(block.reasoning.length > 0
      ? { reasoning_content: block.reasoning.join("") }
      : {}),
    timestamp: options.timestamp,
    turn_id: options.turnId,
  };
  const results: SessionMessage[] = block.tools.flatMap((tool) => {
    const name = toolName(tool);
    if (tool.state === "output-available") {
      return [
        {
          role: "tool",
          tool_call_id: tool.toolCallId,
          name,
          content: tool.output ?? null,
          timestamp: options.timestamp,
          turn_id: options.turnId,
        },
      ];
    }
    if (tool.state === "output-error" || tool.state === "output-denied") {
      return [
        {
          role: "tool",
          tool_call_id: tool.toolCallId,
          name,
          content:
            tool.state === "output-denied"
              ? (tool.approval?.reason ?? "Tool execution denied.")
              : (tool.errorText ?? "Tool execution failed."),
          status: tool.state === "output-denied" ? "denied" : "error",
          timestamp: options.timestamp,
          turn_id: options.turnId,
        },
      ];
    }
    return [];
  });
  return [assistant, ...results];
}

/** 从静态或动态工具 part 中取得稳定的工具名。 */
function toolName(tool: ToolPart): string {
  return tool.type === "dynamic-tool"
    ? (tool.toolName ?? "unknown")
    : tool.type.slice("tool-".length);
}

/** 将工具输入序列化为 OpenAI function.arguments 要求的 JSON 字符串。 */
function stringifyToolArguments(input: unknown): string {
  return JSON.stringify(input ?? {}) ?? "null";
}

/** 读取 function.arguments，异常字符串保留为原始值以便用户检查会话文件。 */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
