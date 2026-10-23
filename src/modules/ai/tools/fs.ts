/**
 * 本文件定义 AI 的文本读取、全文写入和文件树操作工具。
 * 所有文件系统语义由 Rust Agent 文件后端执行，前端只声明 schema、权限模式与审批规则。
 */

import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import {
  accessModeForCall,
  fileOperationNeedsApproval,
  pathNeedsApproval,
} from "./authorization";
import type { ToolContext } from "./context";
import { executeFileMutation, fileEditInputHooks } from "./fileMutation";

/** 创建已知文件读取、完整文件写入和结构化路径操作工具。 */
export function buildFsTools(ctx: ToolContext) {
  const needsPathApproval = (path: string) =>
    ctx.supportsApprovals &&
    ctx.getPermissionMode() === "ask" &&
    pathNeedsApproval(path, ctx.getCwd());
  return {
    read_file: tool({
      description:
        "Read a UTF-8 text file with 1-based line numbers.\n- Before editing existing content, read the relevant range here unless this chat already read or successfully wrote the current version. A partial read allows targeted edits; grep and shell output do not satisfy this requirement.\n- Continue from next_line to read more. If line_truncated=true, do not reconstruct the whole file from this output; increasing start_line cannot retrieve the missing part of that line.\n- If unchanged=true, reuse the previous content or set force=true to read it again. Do not treat omitted content as an empty file.\nBinary, non-UTF-8, oversized files, and device paths are unsupported.",
      inputSchema: z.object({
        path: z.string().min(1),
        start_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("First 1-based line to return. Defaults to 1."),
        line_count: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .optional()
          .describe("Maximum lines to return. Defaults to 2000."),
        force: z
          .boolean()
          .optional()
          .describe(
            "Return the content again even when this exact range and file version were already read. Defaults to false.",
          ),
      }),
      execute: async ({ path, start_line, line_count, force }) => {
        const approvalRequired = needsPathApproval(path);
        try {
          const result = await native.agentFileRead({
            ownerSessionId: ctx.getSessionId(),
            root: ctx.getCwd(),
            permissionMode: accessModeForCall(
              ctx.getPermissionMode(),
              approvalRequired,
            ),
            path,
            startLine: start_line,
            lineCount: line_count,
            force,
          });
          return {
            path: result.path,
            content: result.content,
            size: result.size,
            start_line: result.startLine,
            end_line: result.endLine,
            total_lines: result.totalLines,
            next_line: result.nextLine,
            truncated: result.truncated,
            line_truncated: result.lineTruncated,
            unchanged: result.unchanged,
          };
        } catch (error) {
          return { error: String(error), path };
        }
      },
    }),

    write_file: tool({
      ...fileEditInputHooks(ctx, "write_file"),
      description:
        "Write a complete UTF-8 text file; missing parent directories are created automatically. Use apply_patch for targeted changes or partially read files. Supply raw content without read_file line-number prefixes.",
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string(),
        mode: z
          .enum(["create", "rewrite"])
          .optional()
          .describe(
            "Defaults to create, which requires a missing target. Use rewrite only when this chat has read or successfully written the complete current file content.",
          ),
      }),
      execute: async (input, { toolCallId }) => {
        const sessionId = ctx.getSessionId();
        const approvalRequired = needsPathApproval(input.path);
        return executeFileMutation(ctx, {
          sessionId,
          toolCallId,
          toolName: "write_file",
          input,
          cwd: ctx.getCwd(),
          permissionMode: accessModeForCall(
            ctx.getPermissionMode(),
            approvalRequired,
          ),
        });
      },
    }),

    file_operation: tool({
      description:
        "Move or delete a file or directory, copy a file, or create a directory. For move or copy, provide destination and choose a target that does not already exist; omit destination otherwise. To delete a directory, set recursive=true. Omit recursive for other operations.",
      inputSchema: z
        .object({
          operation: z.enum(["move", "copy", "delete", "create_directory"]),
          path: z.string().min(1),
          destination: z.string().min(1).optional(),
          recursive: z.boolean().optional(),
        })
        .superRefine((input, refinement) => {
          const needsDestination =
            input.operation === "move" || input.operation === "copy";
          if (needsDestination !== Boolean(input.destination)) {
            refinement.addIssue({
              code: "custom",
              path: ["destination"],
              message: needsDestination
                ? "destination is required for move or copy"
                : "destination is only valid for move or copy",
            });
          }
          if (input.operation !== "delete" && input.recursive !== undefined) {
            refinement.addIssue({
              code: "custom",
              path: ["recursive"],
              message: "recursive is only valid for delete",
            });
          }
        }),
      execute: async (input) => {
        const approvalRequired =
          ctx.supportsApprovals &&
          ctx.getPermissionMode() === "ask" &&
          fileOperationNeedsApproval(input, ctx.getCwd());
        try {
          return await native.agentFileOperation({
            ownerSessionId: ctx.getSessionId(),
            root: ctx.getCwd(),
            permissionMode: accessModeForCall(
              ctx.getPermissionMode(),
              approvalRequired,
            ),
            operation: input.operation,
            path: input.path,
            destination: input.destination,
            recursive: input.recursive,
          });
        } catch (error) {
          return {
            error: String(error),
            operation: input.operation,
            path: input.path,
          };
        }
      },
    }),
  } as const;
}
