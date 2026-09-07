/**
 * 本文件桥接 AI 文件修改的 Rust 预备快照。
 * 前端不计算正文或版本，只把模型输入交给统一后端准备、提交和清理。
 */

import type { UIMessage, UIMessagePart } from "ai";

import { native, type AgentMutationInput } from "../lib/native";

export type PreparedFileMutation = Awaited<
  ReturnType<typeof native.agentPrepareMutation>
>;

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
    return {
      kind: "write",
      path: stringField(input, "path"),
      content: stringField(input, "content"),
      mode: input.mode === "rewrite" ? "rewrite" : "create",
    };
  }
  if (!Array.isArray(input.files)) {
    throw new Error("apply_patch files are required");
  }
  return {
    kind: "patch",
    files: input.files.map((value) => {
      const file = record(value);
      if (!Array.isArray(file.edits)) {
        throw new Error("apply_patch edits are required");
      }
      return {
        path: stringField(file, "path"),
        edits: file.edits.map((editValue) => {
          const edit = record(editValue);
          return {
            old_text: stringField(edit, "old_text"),
            new_text: stringField(edit, "new_text"),
            ...(edit.replace_all === true ? { replace_all: true } : {}),
          };
        }),
      };
    }),
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
