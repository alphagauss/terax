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
        'Replace exact text in existing UTF-8 files.\n- Read each target with read_file first unless this chat already read or successfully wrote its current version. Reading the relevant range is sufficient; grep and shell output do not count.\n- Put each replacement directly in edits. Example: {"edits":[{"path":"a.py","old_text":"old","new_text":"new"}]}. Repeat a path for further replacements in the same file, using the same spelling.\n- Use raw content without read_file line-number prefixes. Choose old_text that matches exactly once, or set replace_all=true. Use expected_replacements to require a specific match count. Later edits match the text left by earlier edits to that file.\nIf an edit is invalid, no files are written. If a file changed since reading, reread it and revise the patch.',
      inputSchema: z.strictObject({
        edits: z
          .array(
            z.strictObject({
              path: z
                .string()
                .min(1)
                .describe("Path to an existing UTF-8 file."),
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
              expected_replacements: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe(
                  "Require exactly this many replacements; no files are written if the count differs.",
                ),
            }),
          )
          .min(1)
          .max(100)
          .describe(
            "Ordered replacement objects as a JSON array, not a string; at most 20 distinct files.",
          ),
      }),
      execute: async (input, { toolCallId }) => {
        const sessionId = ctx.getSessionId();
        const approvalRequired =
          ctx.supportsApprovals &&
          ctx.getPermissionMode() === "ask" &&
          input.edits.some((edit) =>
            pathNeedsApproval(edit.path, ctx.getCwd()),
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
