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
        "Inspect commands or errors in the active terminal. Start with the latest output (lines=80, offset=0 by default). To inspect earlier output, increase offset; lines=80, offset=80 requests the previous 80 lines. Do not treat successive reads as a fixed snapshot: new output shifts offsets and can cause overlaps or gaps. Each result is limited to 2000 lines and 24000 characters and may keep only the end of the requested range. If output is empty, do not infer that a command succeeded; there may be no terminal or retained history. Respect Privacy mode refusals.",
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
