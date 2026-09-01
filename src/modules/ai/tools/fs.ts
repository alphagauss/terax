/**
 * 本文件定义 AI 的文本读取、全文写入和文件树操作工具。
 * 所有文件系统语义由 Rust Agent 文件后端执行，前端只声明 schema 与审批规则。
 */

import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import type { ToolContext } from "./context";
import {
  clearPreparedFileMutation,
  commitPreparedFileMutation,
  prepareFileMutation,
} from "./fileMutation";

/** 创建已知文件读取、完整文件写入和结构化路径操作工具。 */
export function buildFsTools(ctx: ToolContext) {
  const needsMutationApproval = () => ctx.getPermissionMode() === "ask";
  return {
    read_file: tool({
      description:
        "Read a known UTF-8 text file with 1-based line numbers. Defaults to 2000 lines and returns next_line when more content exists. Use start_line to continue. Repeating the same unchanged range returns unchanged=true unless force=true. Binary, oversized, sensitive, special-device, and out-of-workspace paths are refused.",
      inputSchema: z.object({
        path: z.string().min(1),
        start_line: z.number().int().min(1).optional(),
        line_count: z.number().int().min(1).max(10_000).optional(),
        force: z.boolean().optional(),
      }),
      execute: async ({ path, start_line, line_count, force }) => {
        try {
          return await native.agentFileRead({
            ownerSessionId: ctx.getSessionId(),
            root: ctx.getCwd(),
            path,
            startLine: start_line,
            lineCount: line_count,
            force,
          });
        } catch (error) {
          return { error: String(error), path };
        }
      },
    }),

    write_file: tool({
      description:
        "Create one complete UTF-8 text file, or intentionally rewrite one complete file. Missing parent directories are created automatically. mode defaults to create and refuses an existing target; rewrite requires read_file on the current version first. Use apply_patch for targeted changes. Follows the current approval mode.",
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string(),
        mode: z.enum(["create", "rewrite"]).optional(),
      }),
      needsApproval: needsMutationApproval,
      execute: async (input, { toolCallId }) => {
        const sessionId = ctx.getSessionId();
        try {
          await prepareFileMutation({
            sessionId,
            toolCallId,
            toolName: "write_file",
            input,
            cwd: ctx.getCwd(),
          });
          return await commitPreparedFileMutation(sessionId, toolCallId);
        } catch (error) {
          clearPreparedFileMutation(sessionId, toolCallId);
          return { error: String(error), path: input.path };
        }
      },
    }),

    file_operation: tool({
      description:
        "Perform one structural filesystem operation: move, copy, delete, or create_directory. move/copy require destination and never overwrite it. copy supports files only. Deleting a directory requires recursive=true. Ordinary file creation should use write_file, which creates parents automatically. Follows the current approval mode.",
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
      needsApproval: needsMutationApproval,
      execute: async ({ operation, path, destination, recursive }) => {
        try {
          return await native.agentFileOperation({
            ownerSessionId: ctx.getSessionId(),
            root: ctx.getCwd(),
            operation,
            path,
            destination,
            recursive,
          });
        } catch (error) {
          return { error: String(error), operation, path };
        }
      },
    }),
  } as const;
}
