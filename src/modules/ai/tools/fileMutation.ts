/**
 * 本文件桥接 AI 文件修改的 Rust 预备快照。
 * 前端不计算正文或版本，只把模型输入交给统一后端准备、提交和清理。
 */

import type { UIMessage, UIMessagePart } from "ai";

import { native, type AgentMutationInput } from "../lib/native";
import {
  getFileEditRuntime,
  peekFileEditRuntime,
} from "@/modules/ai/lib/fileEditRuntime";
import type { ToolContext } from "./context";

export type PreparedFileMutation = Awaited<
  ReturnType<typeof native.agentPrepareMutation>
>;

/** 两个编辑工具共用 SDK 输入事件，回调只入队，不等待解析或动画。 */
export function fileEditInputHooks(
  ctx: ToolContext,
  toolName: "write_file" | "apply_patch",
) {
  return {
    onInputDelta: ({
      toolCallId,
      inputTextDelta,
    }: {
      toolCallId: string;
      inputTextDelta: string;
    }) => {
      getFileEditRuntime(ctx.getSessionId()).input(
        toolCallId,
        ctx.fileEditTaskId,
        toolName,
        inputTextDelta,
        undefined,
        ctx.onFileEditInput,
      );
    },
    onInputAvailable: ({
      toolCallId,
      input,
    }: {
      toolCallId: string;
      input: unknown;
    }) => {
      getFileEditRuntime(ctx.getSessionId()).input(
        toolCallId,
        ctx.fileEditTaskId,
        toolName,
        undefined,
        input,
        ctx.onFileEditInput,
      );
    },
  };
}

/** 成功快照进入展示通道，模型只收到原有精简提交结果。 */
export async function executeFileMutation(
  ctx: ToolContext,
  request: PrepareInput,
) {
  const runtime = getFileEditRuntime(request.sessionId);
  return runtime.track(async () => {
    try {
      await import("@/modules/ai/lib/fileEditDiff");
      const preview = await prepareFileMutation(request);
      const result = await commitPreparedFileMutation(
        request.sessionId,
        request.toolCallId,
      );
      await runtime.complete(
        request.toolCallId,
        ctx.fileEditTaskId,
        result.error
          ? []
          : preview.files.map(
              ({ path, identity, before, after, isNewFile }) => ({
                path: displayMutationPath(path, request.cwd),
                identity,
                before,
                after,
                isNewFile,
              }),
            ),
        result.uncertainPaths ?? [],
      );
      if (result.error)
        clearPreparedFileMutation(request.sessionId, request.toolCallId);
      return {
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.uncertainPaths === undefined
          ? {}
          : { uncertain_paths: result.uncertainPaths }),
        files: result.files.map(({ path, bytesWritten, replacements }) => ({
          path,
          bytes_written: bytesWritten,
          replacements,
        })),
      };
    } catch (error) {
      runtime.fail(request.toolCallId, ctx.fileEditTaskId);
      clearPreparedFileMutation(request.sessionId, request.toolCallId);
      return { error: String(error) };
    }
  });
}

function displayMutationPath(path: string, cwd: string): string {
  const root = `${cwd.replace(/\\/g, "/").replace(/\/$/, "")}/`;
  const windows = /^[a-z]:/i.test(root);
  const inside = windows
    ? path.toLowerCase().startsWith(root.toLowerCase())
    : path.startsWith(root);
  return inside ? path.slice(root.length) : path;
}

type PrepareInput = {
  sessionId: string;
  toolCallId: string;
  toolName: "write_file" | "apply_patch";
  input: Record<string, unknown>;
  cwd: string;
  permissionMode: "ask" | "full-access";
};

/** 将模型工具输入转换为封闭的 Rust 修改请求并准备条件提交快照。 */
export function prepareFileMutation({
  sessionId,
  toolCallId,
  toolName,
  input,
  cwd,
  permissionMode,
}: PrepareInput): Promise<PreparedFileMutation> {
  return native.agentPrepareMutation({
    ownerSessionId: sessionId,
    toolCallId,
    root: cwd,
    permissionMode,
    mutation: mutationInput(toolName, input),
  });
}

/** 提交 Rust 已准备并重新验证的文件修改。 */
export function commitPreparedFileMutation(
  sessionId: string,
  toolCallId: string,
) {
  return native.agentCommitMutation(sessionId, toolCallId);
}

/** 异步释放已经终结或拒绝的预备快照。 */
export function clearPreparedFileMutation(
  sessionId: string,
  toolCallId: string,
): void {
  void native.agentClearMutation(sessionId, toolCallId).catch(() => undefined);
}

/** 判断工具状态是否已经终结，可以释放原生预备快照。 */
export function isTerminalFileMutationState(
  state: string | undefined,
): boolean {
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

function mutationInput(
  toolName: PrepareInput["toolName"],
  input: Record<string, unknown>,
): AgentMutationInput {
  if (toolName === "write_file") {
    if (input.mode !== "create" && input.mode !== "rewrite") {
      throw new Error('write_file requires mode: "create" or "rewrite"');
    }
    return {
      kind: "write",
      path: stringField(input, "path"),
      content: stringField(input, "content"),
      mode: input.mode,
    };
  }
  if (!Array.isArray(input.edits)) {
    throw new Error("apply_patch edits are required");
  }
  const files = new Map<
    string,
    Extract<AgentMutationInput, { kind: "patch" }>["files"][number]
  >();
  for (const value of input.edits) {
    const edit = record(value);
    const path = stringField(edit, "path");
    const file = files.get(path) ?? { path, edits: [] };
    file.edits.push({
      old_text: stringField(edit, "old_text"),
      new_text: stringField(edit, "new_text"),
      ...(edit.replace_all === true ? { replace_all: true } : {}),
      ...(typeof edit.expected_replacements === "number"
        ? { expected_replacements: edit.expected_replacements }
        : {}),
    });
    files.set(path, file);
  }
  return {
    kind: "patch",
    files: [...files.values()],
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object")
    throw new Error("invalid mutation input");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`${key} must be a string`);
  return field;
}

type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

/** 释放终态工具对应的预备快照，避免拒绝操作长期占用原生容量。 */
export function clearTerminalFileMutations(
  sessionId: string,
  messages: readonly UIMessage[],
): void {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts as AnyPart[]) {
      const candidate = part as unknown as {
        type?: string;
        toolName?: string;
        toolCallId?: string;
        state?: string;
      };
      const toolName =
        candidate.type === "dynamic-tool"
          ? candidate.toolName
          : candidate.type?.replace(/^tool-/, "");
      if (
        candidate.toolCallId &&
        toolName &&
        isFileMutation(toolName) &&
        isTerminalFileMutationState(candidate.state)
      ) {
        clearPreparedFileMutation(sessionId, candidate.toolCallId);
        const runtime = peekFileEditRuntime(sessionId);
        if (
          runtime &&
          runtime.getCall(candidate.toolCallId)?.approximate !== false
        )
          runtime.fail(candidate.toolCallId);
      }
    }
  }
}

/** 在运行结束后释放该轮全部预备快照，不清除会话已读取版本。 */
export function clearSessionFileMutations(
  sessionId: string,
  messages: readonly UIMessage[],
): void {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts as AnyPart[]) {
      const candidate = part as unknown as {
        type?: string;
        toolName?: string;
        toolCallId?: string;
      };
      const toolName =
        candidate.type === "dynamic-tool"
          ? candidate.toolName
          : candidate.type?.replace(/^tool-/, "");
      if (candidate.toolCallId && toolName && isFileMutation(toolName)) {
        clearPreparedFileMutation(sessionId, candidate.toolCallId);
      }
    }
  }
}

/** 判断工具是否需要原生文件差异预览。 */
export function isFileMutation(
  toolName: string,
): toolName is "write_file" | "apply_patch" {
  return toolName === "write_file" || toolName === "apply_patch";
}
