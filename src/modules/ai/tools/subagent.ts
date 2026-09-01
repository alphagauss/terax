/**
 * 本文件定义通用 Subagent 工具协议。
 * 工具只负责校验输入并委托会话级协调器，不持有模型、权限或后台状态。
 */

import { tool } from "ai";
import { z } from "zod";
import type { SubagentStartResult } from "../agents/subagentRuntime";

export type SubagentStarter = (options: {
  task: string;
  label?: string;
  wait: boolean;
  abortSignal?: AbortSignal;
}) => Promise<SubagentStartResult>;

/** 创建不包含角色类型、温度或模型覆盖的通用 Subagent 工具。 */
export function buildSubagentTools(start?: SubagentStarter) {
  return {
    run_subagent: tool({
      description:
        "Run a focused subagent with a fresh conversation and the current " +
        "chat's workspace, model policy, and allowed tools. Give it a " +
        "self-contained task. Set wait=true when its result must inform the " +
        "next model step. With wait=false, the tool returns immediately and " +
        "the result is appended later in the same turn. At most the configured " +
        "number of subagents may run concurrently in this chat. Subagents " +
        "cannot create other subagents.",
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
      execute: ({ task, label, wait }, { abortSignal }) =>
        start
          ? start({
              task,
              label,
              wait: wait ?? false,
              abortSignal,
            })
          : {
              status: "rejected" as const,
              error: "Subagent runtime is unavailable for this request.",
            },
    }),
  } as const;
}
