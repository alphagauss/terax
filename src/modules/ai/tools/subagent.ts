/**
 * 本文件定义通用 Subagent 工具协议。
 * 工具只负责校验输入并携带父 tool call ID 委托协调器，不持有模型或后台状态。
 */

import { tool } from "ai";
import { z } from "zod";
import type { SubagentStartResult } from "../agents/subagentRuntime";

export type SubagentStarter = (options: {
  task: string;
  label?: string;
  toolCallId: string;
  wait: boolean;
  abortSignal?: AbortSignal;
}) => Promise<SubagentStartResult>;

export type SubagentAction = {
  action: "list" | "get" | "stop" | "send" | "wait";
  taskId?: string;
  message?: string;
  wait?: boolean;
  timeoutMs?: number;
  offset?: number;
  limit?: number;
};
export type SubagentManager = (
  input: SubagentAction,
  options: { toolCallId: string; abortSignal?: AbortSignal },
) => Promise<unknown>;

/** 只转换子任务结果协议字段，运行时状态与结果正文保持原样。 */
export function subagentToolResult<
  T extends {
    status: string;
    taskId?: string;
    durationMs?: number;
    timedOut?: boolean;
  },
>(result: T) {
  const { taskId, durationMs, timedOut, ...fields } = result;
  return {
    ...fields,
    ...(taskId === undefined ? {} : { task_id: taskId }),
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    ...(timedOut === undefined ? {} : { timed_out: timedOut }),
  };
}

/** 创建不包含角色类型、温度或模型覆盖的通用 Subagent 工具。 */
export function buildSubagentTools(
  start?: SubagentStarter,
  manage?: SubagentManager,
) {
  return {
    subagent_task: tool({
      description:
        "Manage subagents belonging to this chat. list returns task IDs, latest execution states and concurrency limit/running counts; get returns a paginated history of inputs, outputs and tool calls (each entry is limited to 8000 characters; use wait for the full latest final result); wait blocks for the current execution result (default 30 seconds, timeout leaves the task running); stop cancels the task, terminates its managed process trees and waits for cleanup, discarding unconsumed queued instructions; send queues instructions for the next safe boundary of a running task (queued is not yet consumed), or resumes an ended task with a fresh step budget. A finishing task may reject send; retry after completion. stop also cleans up managed processes from ended tasks and prior executions; cleanup=completed confirms cleanup succeeded independently of the latest execution status. stop does not undo completed actions. Use the short task_id returned by this chat. Context-exhausted tasks require a new run_subagent task.",
      inputSchema: z
        .object({
          action: z.enum(["list", "get", "stop", "send", "wait"]),
          task_id: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "Stable task ID returned by run_subagent or list. Required for get, send, stop and wait; tasks must belong to this chat.",
            ),
          message: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "Required for send: additional instructions. Existing task history is retained; do not repeat the original task unless needed.",
            ),
          wait: z
            .boolean()
            .optional()
            .describe(
              "For send to an ended task: wait for the resumed execution to finish. Defaults to false; ignored when instructions are queued for a running task.",
            ),
          timeout_ms: z
            .number()
            .int()
            .min(1000)
            .max(300000)
            .optional()
            .describe(
              "For action=wait: timeout in milliseconds, 1000 to 300000; defaults to 30000. Does not cancel the task.",
            ),
          offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              "History entry offset for get; defaults to the latest page.",
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("History entries for get; defaults to 10."),
        })
        .superRefine((input, context) => {
          const allowed: Record<SubagentAction["action"], readonly string[]> = {
            list: [],
            get: ["task_id", "offset", "limit"],
            stop: ["task_id"],
            wait: ["task_id", "timeout_ms"],
            send: ["task_id", "message", "wait"],
          };
          for (const [key, value] of Object.entries(input)) {
            if (
              key !== "action" &&
              value !== undefined &&
              !allowed[input.action].includes(key)
            )
              context.addIssue({
                code: "custom",
                path: [key],
                message: `${key} is not supported for action=${input.action}.`,
              });
          }
          if (input.action !== "list" && !input.task_id)
            context.addIssue({
              code: "custom",
              path: ["task_id"],
              message: "task_id is required.",
            });
          if (input.action === "send" && !input.message)
            context.addIssue({
              code: "custom",
              path: ["message"],
              message: "message is required for send.",
            });
        }),
      execute: async (input, options) => {
        if (input.action !== "list" && !input.task_id)
          return { status: "rejected", error: "task_id is required." };
        if (input.action === "send" && !input.message)
          return { status: "rejected", error: "message is required." };
        return manage
          ? manage(
              {
                action: input.action,
                taskId: input.task_id,
                timeoutMs: input.timeout_ms,
                message: input.message,
                wait: input.wait,
                offset: input.offset,
                limit: input.limit,
              },
              options,
            )
          : {
              status: "rejected",
              error: "Subagent runtime is unavailable for this request.",
            };
      },
    }),
    run_subagent: tool({
      description:
        "Run a focused subagent with a fresh conversation and the current " +
        "chat's workspace, model policy, and permission-filtered tools. It cannot request interactive approval. Give it a " +
        "self-contained task. Set wait=true when its result must inform the " +
        "next model step. With wait=false, the tool returns immediately and " +
        "the result is appended later in the same turn unless retrieved by subagent_task wait. Use the returned task_id to inspect, stop, wait for, or continue this task. At most the configured " +
        "number of subagents may run concurrently in this chat. Subagents " +
        "cannot create other subagents. Managed background processes may keep running after a subagent completes; use subagent_task stop to clean them up.",
      inputSchema: z.object({
        task: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Self-contained task. The subagent has no parent chat history, so include all relevant context.",
          ),
        label: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .optional()
          .describe("Short label shown in the chat UI."),
        wait: z
          .boolean()
          .default(false)
          .describe(
            "Wait for the final result before the main agent continues. Defaults to false for background execution.",
          ),
      }),
      execute: async ({ task, label, wait }, { abortSignal, toolCallId }) =>
        start
          ? subagentToolResult(
              await start({
                task,
                label,
                toolCallId,
                wait: wait ?? false,
                abortSignal,
              }),
            )
          : {
              status: "rejected" as const,
              error: "Subagent runtime is unavailable for this request.",
            },
    }),
  } as const;
}
