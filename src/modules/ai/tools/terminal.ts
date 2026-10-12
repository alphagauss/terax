/**
 * 本文件定义 AI 读取活动终端输出的工具。
 * 隐私终端拒绝读取，返回内容经过行数和字符数双重限制。
 */

import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

/** 创建受隐私模式和输出上限约束的终端读取工具。 */
export function buildTerminalTools(ctx: ToolContext) {
  return {
    get_terminal_output: tool({
      description:
        "Read retained output from the active terminal to inspect commands or errors. Defaults: lines=80, offset=0. offset skips lines from the end; lines=80, offset=80 reads the previous 80 lines. New output shifts offsets, so pages may overlap or miss lines. Returns up to 2000 lines and 24000 characters; character truncation keeps the end of the requested range. Returns empty output when no terminal or history is available; refuses Privacy mode.",
      inputSchema: z.object({
        lines: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            "Maximum lines to return after skipping offset lines. Default 80; max 2000.",
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Lines to skip from the end of the live buffer. Default 0.",
          ),
      }),
      execute: async ({ lines, offset }) => {
        if (ctx.isActiveTerminalPrivate()) {
          return {
            error:
              "active terminal is in Privacy mode; its buffer is withheld. Ask the user to switch to a regular tab if they want you to see it.",
          };
        }
        const n = lines ?? 80;
        const skipped = offset ?? 0;
        const buffer = ctx.getTerminalContext(n + skipped);
        if (!buffer) return { output: "", note: "no active terminal" };
        const parts = buffer.split("\n");
        const end = Math.max(0, parts.length - skipped);
        const start = Math.max(0, end - n);
        const sliced = parts.slice(start, end).join("\n");
        const MAX = 24_000;
        const marker = "…[truncated]…\n";
        const truncated = sliced.length > MAX;
        const body = truncated ? sliced.slice(-(MAX - marker.length)) : sliced;
        return {
          output: truncated ? `${marker}${body}` : body,
          // 只统计终端正文，截断提示行不计入返回行数。
          lines_returned: truncated ? body.split("\n").length : end - start,
          truncated,
        };
      },
    }),
  } as const;
}
