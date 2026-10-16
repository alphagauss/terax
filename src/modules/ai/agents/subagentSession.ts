/**
 * 子会话以父会话中的增量记录保存，复用主会话的模型事实与展示投影。
 * 父轮次限定分叉边界；运行 ID 只用于内部归属，不暴露给模型。
 */
import type { SubagentDisplaySnapshot } from "@/modules/ai/agents/subagentDisplay";
import {
  convertToAgentModelMessages,
  projectSessionMessages,
  type SessionMessage,
} from "@/modules/ai/lib/conversation";
import { commitSession, readSession } from "@/modules/ai/lib/sessions";
import { describeToolCall } from "@/modules/ai/lib/toolSummary";
import type { ModelMessage } from "ai";

export type SubagentStatus =
  | "running"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "context_exhausted";
export type SubagentRecord = {
  taskId: string;
  runId: string;
  label: string;
  records?: SessionMessage[];
  toolCallId?: string;
  systemPrompt?: string;
  execution?: {
    id: string;
    name: string;
    input?: unknown;
    output?: unknown;
    status: "started" | "finished";
  };
  status?: SubagentStatus;
  error?: string;
  queued?: { id: string; message: string };
  consumed?: string[];
};
export type SubagentSession = {
  taskId: string;
  runId: string;
  label: string;
  records: SessionMessage[];
  systemPrompt?: string;
  executions?: NonNullable<SubagentRecord["execution"]>[];
  status: SubagentStatus;
  error?: string;
  pending: { id: string; message: string; ready?: Promise<void> }[];
};

/** 恢复嵌套会话，未完成执行只标为中断，不自动重放工具。 */
export function restoreSubagentSessions(records: readonly SessionMessage[]) {
  const tasks = new Map<string, SubagentSession>();
  for (const record of records) {
    if (record.role !== "subagent") continue;
    const entry = record.content;
    let task = tasks.get(entry.taskId);
    if (!task) {
      task = {
        taskId: entry.taskId,
        runId: entry.runId,
        label: entry.label,
        records: [],
        status: "interrupted",
        pending: [],
      };
      tasks.set(entry.taskId, task);
    }
    if (task.runId !== entry.runId) task.executions = [];
    task.runId = entry.runId;
    if (entry.systemPrompt !== undefined)
      task.systemPrompt = entry.systemPrompt;
    if (entry.execution) {
      task.executions ??= [];
      task.executions.push(entry.execution);
    }
    task.records.push(...(entry.records ?? []));
    if (entry.status) {
      task.status = entry.status;
      task.error = entry.error;
    }
  }
  for (const task of tasks.values()) {
    if (task.status === "running") task.status = "interrupted";
    task.pending = [];
  }
  return tasks;
}

export class SubagentSessions {
  readonly tasks = new Map<string, SubagentSession>();
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly persist?: (record: SubagentRecord) => Promise<void>,
  ) {}

  /** 只有持久化成功才提交内存事实；串行化并发子任务写入。 */
  async append(
    task: SubagentSession,
    update: Omit<SubagentRecord, "taskId" | "runId" | "label">,
  ) {
    const record = structuredClone({
      taskId: task.taskId,
      runId: task.runId,
      label: task.label,
      ...update,
    });
    const write = this.writes.then(async () => {
      await this.persist?.(record);
      task.records.push(...(record.records ?? []));
      if (record.systemPrompt !== undefined)
        task.systemPrompt = record.systemPrompt;
      if (record.execution) {
        task.executions ??= [];
        task.executions.push(record.execution);
      }
      if (record.status) {
        task.status = record.status;
        task.error = record.error;
      }
    });
    this.writes = write.catch(() => undefined);
    await write;
  }

  async history(task: SubagentSession): Promise<ModelMessage[]> {
    return convertToAgentModelMessages(
      projectSessionMessages(task.taskId, task.records),
    );
  }
}

/** 中断或总结阶段可能留下无结果调用；追加明确失败事实，禁止 SDK 在恢复时执行旧调用。 */
export function unfinishedToolResults(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call")
        pending.set(part.toolCallId, part.toolName);
      if (part.type === "tool-result") pending.delete(part.toolCallId);
    }
  }
  if (!pending.size) return [];
  return [
    {
      role: "tool",
      content: [...pending].map(([toolCallId, toolName]) => ({
        type: "tool-result",
        toolCallId,
        toolName,
        output: {
          type: "error-text",
          value:
            "The previous execution ended without a recorded tool result. The call will not be replayed. Inspect execution facts and current state before retrying any side effect.",
        },
      })),
    },
  ];
}

/** 懒加载于父轮用户输入落盘之后，所有子记录沿用父会话原生运行锁。 */
export async function openSubagentSessions(sessionId: string, turnId: string) {
  const session = await readSession(sessionId);
  const store = new SubagentSessions(async (content) => {
    await commitSession({
      ...session,
      updatedAt: Date.now(),
      messages: [
        {
          role: "subagent",
          content,
          turn_id: turnId,
          timestamp: new Date().toISOString(),
        },
      ],
    });
  });
  for (const [id, task] of restoreSubagentSessions(session.messages))
    store.tasks.set(id, task);
  return store;
}

/** 只提取指定执行的最后正文，不能把上一次执行的回答作为本次结果。 */
export function subagentResultText(
  records: readonly SessionMessage[],
): string | undefined {
  let result: string | undefined;
  for (const record of records) {
    if (record.role === "assistant")
      result = record.content.trim() ? record.content : undefined;
    if (record.role === "model")
      for (const message of record.content) {
        if (message.role !== "assistant") continue;
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
        result = text.trim() ? text : undefined;
      }
  }
  return result;
}

/** 已结束任务无需运行对象；从该次执行的权威历史返回结果。 */
export function restoredSubagentResult(task: SubagentSession) {
  const records = task.records.filter(
    (record) => record.turn_id === task.runId,
  );
  return {
    taskId: task.taskId,
    label: task.label,
    status: task.status,
    result:
      subagentResultText(records) ??
      (task.status === "completed"
        ? "Task completed but no final response was generated."
        : undefined),
    ...(task.error ? { error: task.error } : {}),
  };
}

/** 历史卡片从执行事实派生，不另外保存工具摘要副本。 */
export function projectSubagentDisplays(
  records: readonly SessionMessage[],
): SubagentDisplaySnapshot[] {
  const runs = new Map<
    string,
    { snapshot: SubagentDisplaySnapshot; startedAt: number }
  >();
  for (const record of records) {
    if (record.role !== "subagent") continue;
    const entry = record.content;
    if (entry.toolCallId)
      runs.set(entry.runId, {
        startedAt: Date.parse(record.timestamp),
        snapshot: {
          version: 2,
          runId: entry.runId,
          parentTurnId: record.turn_id,
          instructions: (entry.records ?? [])
            .filter((item) => item.role === "user")
            .slice(-1)
            .map((item) => String(item.content)),
          taskId: entry.taskId,
          toolCallId: entry.toolCallId,
          label: entry.label,
          status: "cancelled",
          durationMs: 0,
          steps: [],
        },
      });
    const run = runs.get(entry.runId);
    if (!run) continue;
    const snapshot = run.snapshot;
    if (entry.consumed && entry.records) {
      snapshot.instructions = [...(snapshot.instructions ?? []),
        ...entry.records.filter((item) => item.role === "user").map((item) => String(item.content))];
    }
    const result = subagentResultText(entry.records ?? []);
    if (
      entry.records?.some(
        (record) => record.role === "model" || record.role === "assistant",
      )
    )
      snapshot.result = result;
    if (entry.error !== undefined) snapshot.error = entry.error;
    const execution = entry.execution;
    if (execution?.status === "started")
      snapshot.steps.push({
        id: execution.id,
        toolName: execution.name,
        summary: describeToolCall(execution.name, execution.input),
        status: "cancelled",
      });
    if (execution?.status === "finished") {
      const step = snapshot.steps.find((step) => step.id === execution.id);
      const output = execution.output as
        | { type?: string; output?: { error?: unknown } }
        | undefined;
      if (step)
        step.status =
          output?.type === "tool-result" && !output.output?.error
            ? "completed"
            : "failed";
    }
    if (entry.status && entry.status !== "running") {
      snapshot.status =
        entry.status === "context_exhausted"
          ? "failed"
          : entry.status === "interrupted"
            ? "cancelled"
            : entry.status;
      snapshot.durationMs = Math.max(
        0,
        Date.parse(record.timestamp) - run.startedAt,
      );
    }
  }
  return [...runs.values()].map((run) => run.snapshot);
}
