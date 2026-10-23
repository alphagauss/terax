/**
 * 本文件定义 AI 的多文件精确补丁工具。
 * Rust 后端要求当前聊天通过读取或成功编辑建立当前版本基线，并保证预备快照与条件提交使用同一基线。
 */

import { tool } from "ai";
import { z } from "zod";
import { accessModeForCall, pathNeedsApproval } from "./authorization";
import type { ToolContext } from "./context";
import { executeFileMutation, fileEditInputHooks } from "./fileMutation";

/** 创建支持一个或多个已有文本文件的严格精确补丁工具。 */
export function buildPatchTools(ctx: ToolContext) {
  return {
    apply_patch: tool({
      ...fileEditInputHooks(ctx, "apply_patch"),
      description:
        'Replace exact text in existing UTF-8 files.\n- Read each target with read_file first unless this chat already read or successfully wrote its current version. Reading the relevant range is sufficient; grep and shell output do not count.\n- Put path and edits inside each files entry. Example: {"files":[{"path":"a.py","edits":[{"old_text":"old","new_text":"new"}]}]}.\n- Use raw content without read_file line-number prefixes. Choose old_text that matches exactly once, or set replace_all=true. For multiple edits to one file, match the text left by earlier edits.\nIf an edit is invalid, no files are written. If a file changed since reading, reread it and revise the patch.',
      inputSchema: z.object({
        files: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .describe(
                  "Path to an existing UTF-8 file; include each path only once.",
                ),
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
