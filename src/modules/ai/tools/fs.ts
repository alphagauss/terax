/**
 * 本文件定义 AI 的文本读取、全文写入和文件树操作工具。
 * 所有文件系统语义由 Rust Agent 文件后端执行，前端只声明 schema、权限模式与审批规则。
 */

import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import type { ToolContext } from "./context";
import {
  accessModeForCall,
  fileOperationNeedsApproval,
  pathNeedsApproval,
} from "./authorization";
import {
  clearPreparedFileMutation,
  commitPreparedFileMutation,
  prepareFileMutation,
} from "./fileMutation";

/** 创建已知文件读取、完整文件写入和结构化路径操作工具。 */
export function buildFsTools(ctx: ToolContext) {
  const needsPathApproval = (path: string) =>
    ctx.supportsApprovals &&
    ctx.getPermissionMode() === "ask" &&
    pathNeedsApproval(path, ctx.getCwd());
  return {
    read_file: tool({
      description:
        "Read a known UTF-8 text file with 1-based line numbers. Defaults to 2000 lines and returns next_line when more content exists. Use start_line to continue. Repeating the same unchanged range returns unchanged=true unless force=true. Binary, oversized, and special-device paths are refused. Outside-workspace and sensitive paths require approval unless full access is enabled.",
      inputSchema: z.object({
        path: z.string().min(1),
        start_line: z.number().int().min(1).optional(),
        line_count: z.number().int().min(1).max(10_000).optional(),
        force: z.boolean().optional(),
      }),
      needsApproval: ({ path }) => needsPathApproval(path),
      execute: async ({ path, start_line, line_count, force }) => {
        const approvalRequired = needsPathApproval(path);
        try {
          return await native.agentFileRead({
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
        } catch (error) {
          return { error: String(error), path };
        }
      },
    }),

    write_file: tool({
      description:
        "Create one complete UTF-8 text file, or intentionally rewrite one complete file. Missing parent directories are created automatically. mode defaults to create and refuses an existing target; rewrite requires read_file on the current version first. Use apply_patch for targeted changes. Workspace-local writes run automatically; outside or sensitive paths require approval unless full access is enabled.",
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string(),
        mode: z.enum(["create", "rewrite"]).optional(),
      }),
      needsApproval: ({ path }) => needsPathApproval(path),
      execute: async (input, { toolCallId }) => {
        const sessionId = ctx.getSessionId();
        const approvalRequired = needsPathApproval(input.path);
        try {
          await prepareFileMutation({
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
          return await commitPreparedFileMutation(sessionId, toolCallId);
        } catch (error) {
          clearPreparedFileMutation(sessionId, toolCallId);
          return { error: String(error), path: input.path };
        }
      },
    }),

    file_operation: tool({
      description:
        "Perform one structural filesystem operation: move, copy, delete, or create_directory. move/copy require destination and never overwrite it. copy supports files only. Deleting a directory requires recursive=true. Workspace-local ordinary operations run automatically; recursive deletion, outside paths, and sensitive paths require approval unless full access is enabled.",
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
      needsApproval: (input) =>
        ctx.supportsApprovals &&
        ctx.getPermissionMode() === "ask" &&
        fileOperationNeedsApproval(input, ctx.getCwd()),
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
