/**
 * 本文件桥接 AI 文件修改的 Rust 审批快照。
 * 前端不计算正文或版本，只把模型输入交给统一后端准备、提交和清理。
 */

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
};

/** 将模型工具输入转换为封闭的 Rust 修改请求并准备审批快照。 */
export function prepareFileMutation({
  sessionId,
  toolCallId,
  toolName,
  input,
  cwd,
}: PrepareInput): Promise<PreparedFileMutation> {
  return native.agentPrepareMutation({
    ownerSessionId: sessionId,
    toolCallId,
    root: cwd,
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

/** 异步释放已经终结或拒绝的审批快照。 */
export function clearPreparedFileMutation(
  sessionId: string,
  toolCallId: string,
): void {
  void native.agentClearMutation(sessionId, toolCallId).catch(() => undefined);
}

/** 判断工具状态是否已经终结，可以释放原生审批快照。 */
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
