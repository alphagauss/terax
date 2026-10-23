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
        "Manage this chat's subagents.\n- list: find task IDs, states, and available concurrency.\n- get: inspect paginated task history. Entries may be truncated; use wait for the full latest final result.\n- wait: obtain a task's result before proceeding. A timeout leaves it running.\n- send: add instructions or resume an ended task. queued means the instructions have not yet been read. Retry after completion only if the error says the task is finishing; for exhausted context, start a new task.\n- stop: cancel the task, discard unread instructions, and clean up its managed processes, including earlier runs. Check cleanup=completed before claiming cleanup succeeded. Completed actions are not undone; an already-ended task keeps its status.",
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
        "Delegate a focused task in this chat's workspace. Assign work that can be completed with the available tools, without interactive approval or further delegation. Check subagent_task action=list for available concurrency before starting more tasks. Use the returned task_id with subagent_task to follow up or stop the task and clean up its managed processes.",
      inputSchema: z.object({
        task: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Include the necessary context, paths, constraints, and expected result. The subagent cannot see the parent chat history.",
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
            "Use true when the next step needs the result. Defaults to false: continue independent work, then use subagent_task action=wait if the result has not arrived.",
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
