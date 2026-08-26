/**
 * 本文件定义 AI 的多文件精确补丁工具。
 * Rust 后端要求当前聊天先读取每个目标，并保证审批快照与条件提交使用同一基线。
 */

import { tool } from "ai";
import { z } from "zod";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "./context";
import {
  clearPreparedFileMutation,
  commitPreparedFileMutation,
  prepareFileMutation,
} from "./fileMutation";

/** 创建支持一个或多个已有文本文件的严格精确补丁工具。 */
export function buildPatchTools(ctx: ToolContext) {
  return {
    apply_patch: tool({
      description:
        "Apply ordered exact-text replacements to one or more existing UTF-8 files. Every file must be read with read_file first. Each non-replace_all old_text must occur exactly once; any invalid edit aborts the whole preparation before writing. Use write_file for new files or complete rewrites. Follows the current approval mode.",
      inputSchema: z.object({
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              edits: z
                .array(
                  z.object({
                    old_text: z.string().min(1),
                    new_text: z.string(),
                    replace_all: z.boolean().optional(),
                  }),
                )
                .min(1)
                .max(100),
            }),
          )
          .min(1)
          .max(20),
      }),
      needsApproval: () => useChatStore.getState().permissionMode === "ask",
      execute: async (input, { toolCallId }) => {
        const sessionId = ctx.getSessionId();
        try {
          await prepareFileMutation({
            sessionId,
            toolCallId,
            toolName: "apply_patch",
            input,
            cwd: ctx.getCwd(),
          });
          return await commitPreparedFileMutation(sessionId, toolCallId);
        } catch (error) {
          clearPreparedFileMutation(sessionId, toolCallId);
          return { error: String(error) };
        }
      },
    }),
  } as const;
}
