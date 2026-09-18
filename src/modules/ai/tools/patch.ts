/**
 * 本文件定义 AI 的多文件精确补丁工具。
 * Rust 后端要求当前聊天先读取每个目标，并保证预备快照与条件提交使用同一基线。
 */

import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { accessModeForCall, pathNeedsApproval } from "./authorization";
import { executeFileMutation, fileEditInputHooks } from "./fileMutation";

/** 创建支持一个或多个已有文本文件的严格精确补丁工具。 */
export function buildPatchTools(ctx: ToolContext) {
  return {
    apply_patch: tool({
      ...fileEditInputHooks(ctx, "apply_patch"),
      description:
        'Apply ordered exact-text replacements to one or more existing UTF-8 files. Every file must be read with read_file first. Each non-replace_all old_text must occur exactly once; any invalid edit aborts the whole preparation before writing. Pass files and edits as JSON arrays, never as JSON-encoded strings. Example: {"files":[{"path":"a.py","edits":[{"old_text":"old","new_text":"new"}]}]}. Workspace-local patches run automatically; outside or sensitive paths require approval unless full access is enabled.',
      inputSchema: z.object({
        files: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .describe("Path to an existing UTF-8 file read in this chat."),
              edits: z
                .array(
                  z.object({
                    old_text: z
                      .string()
                      .min(1)
                      .describe("Exact text from the current file version."),
                    new_text: z
                      .string()
                      .describe("Complete replacement text, not a diff."),
                    replace_all: z
                      .boolean()
                      .optional()
                      .describe("Replace every match instead of exactly one."),
                  }),
                )
                .min(1)
                .max(100)
                .describe("Ordered exact-text replacements for this file."),
            }),
          )
          .min(1)
          .max(20)
          .describe("File patch objects as a JSON array, not a string."),
      }),
      execute: async (input, { toolCallId }) => {
        const sessionId = ctx.getSessionId();
        const approvalRequired =
          ctx.supportsApprovals &&
          ctx.getPermissionMode() === "ask" &&
          input.files.some((file) =>
            pathNeedsApproval(file.path, ctx.getCwd()),
          );
        return executeFileMutation(ctx, {
          sessionId,
          toolCallId,
          toolName: "apply_patch",
          input,
          cwd: ctx.getCwd(),
          permissionMode: accessModeForCall(
            ctx.getPermissionMode(),
            approvalRequired,
          ),
        });
      },
    }),
  } as const;
}
