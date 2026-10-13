/**
 * 本文件定义 AI 的路径发现与正文搜索工具。
 * Rust Agent 文件后端统一 Local、WSL、SSH 的权限、安全过滤、聚合和分页语义。
 */

import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { accessModeForCall, pathNeedsApproval } from "./authorization";
import type { ToolContext } from "./context";

/** 创建路径发现和文本内容搜索工具。 */
export function buildSearchTools(ctx: ToolContext) {
  return {
    find_files: tool({
      description:
        "Discover files and directories by path. Prefer this over shell directory listings. Without recursive it lists immediate children; with recursive=true it walks the tree and honors ignore files. glob matches relative paths, for example '**/*.ts'. Results are paged with offset/limit. Use grep to search file contents. Outside-workspace and sensitive paths require approval unless full access is enabled.",
      inputSchema: z.object({
        path: z.string().min(1).optional(),
        glob: z.string().min(1).optional(),
        recursive: z
          .boolean()
          .optional()
          .describe(
            "Walk the full tree instead of listing immediate children. Defaults to false.",
          ),
        include_directories: z
          .boolean()
          .optional()
          .describe(
            "Include directories in results. Defaults to true for immediate listing and false for recursive search.",
          ),
        include_hidden: z.boolean().optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(2_000).optional(),
      }),
      execute: async (input) => {
        const approvalRequired =
          ctx.supportsApprovals &&
          ctx.getPermissionMode() === "ask" &&
          pathNeedsApproval(input.path ?? ".", ctx.getCwd());
        try {
          return await native.agentFileFind({
            ownerSessionId: ctx.getSessionId(),
            root: ctx.getCwd(),
            permissionMode: accessModeForCall(
              ctx.getPermissionMode(),
              approvalRequired,
            ),
            path: input.path,
            glob: input.glob,
            recursive: input.recursive,
            includeDirectories: input.include_directories,
            includeHidden: input.include_hidden,
            offset: input.offset,
            limit: input.limit,
          });
        } catch (error) {
          return { error: String(error), path: input.path ?? "." };
        }
      },
    }),

    grep: tool({
      description:
        "Search UTF-8 file contents in a file or directory. Limit path to the relevant project or subdirectory before searching. Supports literal or Rust-regex syntax, include globs, content/files/count output, bounded context, and offset/limit pagination. Continue from next_offset when present. If truncated=true without next_offset, narrow path, include, or pattern. Counts may be incomplete when truncated=true. Outside-workspace and sensitive paths require approval unless full access is enabled. Prefer this over shell grep.",
      inputSchema: z
        .object({
          pattern: z.string().min(1),
          path: z.string().min(1).optional(),
          syntax: z
            .enum(["literal", "regex"])
            .optional()
            .describe(
              "Pattern syntax. Defaults to regex; use literal for exact source text containing punctuation.",
            ),
          case_insensitive: z.boolean().optional(),
          include: z.array(z.string().min(1)).max(32).optional(),
          output: z
            .enum(["content", "files", "count"])
            .optional()
            .describe(
              "Return matching lines, unique file paths, or per-file counts. Defaults to content.",
            ),
          context_lines: z
            .number()
            .int()
            .min(0)
            .max(20)
            .optional()
            .describe(
              "Lines of context before and after each match. Defaults to 0; positive values require output=content.",
            ),
          offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              "Pagination offset into matching lines, file paths, or count records according to output.",
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe(
              "Maximum matching lines, file paths, or count records to return. Defaults to 30.",
            ),
        })
        .superRefine((input, refinement) => {
          if (
            input.output !== undefined &&
            input.output !== "content" &&
            (input.context_lines ?? 0) > 0
          ) {
            refinement.addIssue({
              code: "custom",
              path: ["context_lines"],
              message: "positive context_lines requires output=content",
            });
          }
        }),
      execute: async (input) => {
        const approvalRequired =
          ctx.supportsApprovals &&
          ctx.getPermissionMode() === "ask" &&
          pathNeedsApproval(input.path ?? ".", ctx.getCwd());
        try {
          return await native.agentFileGrep({
            ownerSessionId: ctx.getSessionId(),
            root: ctx.getCwd(),
            permissionMode: accessModeForCall(
              ctx.getPermissionMode(),
              approvalRequired,
            ),
            path: input.path,
            pattern: input.pattern,
            syntax: input.syntax,
            caseInsensitive: input.case_insensitive,
            include: input.include,
            output: input.output,
            contextLines: input.context_lines,
            offset: input.offset,
            limit: input.limit,
          });
        } catch (error) {
          return { error: String(error), path: input.path ?? "." };
        }
      },
    }),
  } as const;
}
