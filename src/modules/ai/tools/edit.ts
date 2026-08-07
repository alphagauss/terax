/**
 * 本文件定义 AI 的单处和批量文本编辑工具。
 * 编辑遵守先读后写，并通过统一文件修改快照保证审批内容与最终写入一致。
 */

import { tool } from "ai";
import { z } from "zod";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "./context";
import {
  clearPreparedFileMutation,
  commitPreparedFileMutation,
  getPreparedFileMutation,
  prepareFileMutation,
  type PreparedFileMutation,
} from "./fileMutation";

type EditInput = {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

type MultiEditInput = {
  path: string;
  edits: Array<{
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }>;
};

/** 提交已规划的编辑，并更新当前会话的先读缓存。 */
async function executePreparedEdit(
  ctx: ToolContext,
  prepared: PreparedFileMutation,
): Promise<{
  ok: true;
  replacements: number;
  bytesWritten: number;
  path: string;
}> {
  if (!ctx.readCache.has(prepared.path)) {
    throw new Error(
      "must call read_file on this path first (read-before-edit invariant).",
    );
  }
  await commitPreparedFileMutation(prepared);
  ctx.readCache.set(prepared.path, {
    size: prepared.after.length,
    hash: hashText(prepared.after),
  });
  return {
    ok: true,
    replacements: prepared.replacements,
    bytesWritten: prepared.after.length,
    path: prepared.path,
  };
}

/** 创建文本编辑工具，并为写操作动态应用当前权限模式。 */
export function buildEditTools(ctx: ToolContext) {
  return {
    edit: tool({
      description:
        "Replace an exact string in a file. Requires read_file on this path first in the current session to prevent blind edits. `old_string` must be unique in the file unless `replace_all: true`. Follows the current approval mode.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z
          .string()
          .describe(
            "Exact substring to replace. Must be unique unless replace_all.",
          ),
        new_string: z.string().describe("Replacement substring."),
        replace_all: z.boolean().optional(),
      }),
      needsApproval: () => useChatStore.getState().permissionMode === "ask",
      execute: async (input: EditInput, { toolCallId }) =>
        executeEditTool(ctx, "edit", input, toolCallId),
    }),

    multi_edit: tool({
      description:
        "Apply several exact-string replacements to a single file atomically. Each edit is applied in order to the running buffer; if any edit's old_string is missing or non-unique, the whole batch aborts before writing. Requires prior read_file on the path. Follows the current approval mode.",
      inputSchema: z.object({
        path: z.string(),
        edits: z
          .array(
            z.object({
              old_string: z.string(),
              new_string: z.string(),
              replace_all: z.boolean().optional(),
            }),
          )
          .min(1),
      }),
      needsApproval: () => useChatStore.getState().permissionMode === "ask",
      execute: async (input: MultiEditInput, { toolCallId }) =>
        executeEditTool(ctx, "multi_edit", input, toolCallId),
    }),
  } as const;
}

async function executeEditTool(
  ctx: ToolContext,
  toolName: "edit" | "multi_edit",
  input: EditInput | MultiEditInput,
  toolCallId: string,
) {
  const sessionId = ctx.getSessionId();
  try {
    const prepared =
      getPreparedFileMutation(sessionId, toolCallId) ??
      (await prepareFileMutation({
        sessionId,
        toolCallId,
        toolName,
        input,
        cwd: ctx.getCwd(),
      }));
    return await executePreparedEdit(ctx, prepared);
  } catch (error) {
    clearPreparedFileMutation(sessionId, toolCallId);
    return { error: String(error), path: input.path };
  }
}

function hashText(content: string): number {
  let hash = 5381;
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) + hash + content.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}
