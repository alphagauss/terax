/**
 * 本文件定义 AI 的路径发现与正文搜索工具。
 * Rust Agent 文件后端统一 Local、WSL、SSH 的 ignore、安全过滤、聚合和分页语义。
 */

import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import type { ToolContext } from "./context";

/** 创建路径发现和文本内容搜索工具。 */
export function buildSearchTools(ctx: ToolContext) {
  return {
    find_files: tool({
      description:
        "Discover files and directories by path. Without recursive it lists immediate children; with recursive=true it walks the tree and honors ignore files. glob matches relative paths, for example '**/*.ts'. Results are paged with offset/limit. Use grep to search file contents.",
      inputSchema: z.object({
        path: z.string().min(1).optional(),
        glob: z.string().min(1).optional(),
        recursive: z.boolean().optional(),
        include_directories: z.boolean().optional(),
        include_hidden: z.boolean().optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(2_000).optional(),
      }),
      execute: async (input) => {
        try {
          return await native.agentFileFind({
            ownerSessionId: ctx.getSessionId(),
            root: ctx.getCwd(),
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
        "Search UTF-8 file contents in a file or directory. Supports literal or Rust-regex syntax, include globs, content/files/count output, bounded context, and offset/limit pagination. Honors ignore files and refuses sensitive paths. Prefer this over shell grep.",
      inputSchema: z.object({
        pattern: z.string().min(1),
        path: z.string().min(1).optional(),
        syntax: z.enum(["literal", "regex"]).optional(),
        case_insensitive: z.boolean().optional(),
        include: z.array(z.string().min(1)).max(32).optional(),
        output: z.enum(["content", "files", "count"]).optional(),
        context_lines: z.number().int().min(0).max(20).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      execute: async (input) => {
        try {
          return await native.agentFileGrep({
            ownerSessionId: ctx.getSessionId(),
            root: ctx.getCwd(),
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
