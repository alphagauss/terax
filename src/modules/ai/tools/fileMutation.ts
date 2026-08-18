/**
 * 本文件统一规划和提交 AI 文件修改。
 * 审批预览与最终写入共享同一快照，并在写入前验证路径和文件基线未变化。
 */

import { native, type FileVersion } from "../lib/native";
import { checkWritableCanonical } from "../lib/security";
import { resolvePath } from "./context";

export type EditOperation = {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

export type PreparedFileMutation = {
  sessionId: string;
  toolCallId: string;
  toolName: "write_file" | "edit" | "multi_edit";
  path: string;
  before: string;
  after: string;
  isNewFile: boolean;
  version: FileVersion | null;
  replacements: number;
};

type PrepareInput = {
  sessionId: string;
  toolCallId: string;
  toolName: PreparedFileMutation["toolName"];
  input: Record<string, unknown>;
  cwd: string;
};

type TextSnapshot = {
  content: string;
  isNewFile: boolean;
  version: FileVersion | null;
};

const preparedMutations = new Map<string, PreparedFileMutation>();
const preparingMutations = new Map<string, Promise<PreparedFileMutation>>();

/** 生成文件工具调用的运行时缓存键。 */
export function fileMutationKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

/**
 * 对文本依次应用精确替换。
 * 任一替换不满足唯一性或存在性要求时整体失败，不返回部分结果。
 */
export function applyTextEdits(
  original: string,
  edits: readonly EditOperation[],
): { content: string; replacements: number } {
  let content = original;
  let replacements = 0;
  for (const edit of edits) {
    if (!edit.old_string) throw new Error("old_string cannot be empty");
    if (edit.old_string === edit.new_string) {
      throw new Error("old_string and new_string are identical");
    }
    if (edit.replace_all) {
      const count = countOccurrences(content, edit.old_string);
      if (count === 0) {
        throw new Error(
          `old_string not found: ${JSON.stringify(edit.old_string.slice(0, 80))}`,
        );
      }
      content = content.split(edit.old_string).join(edit.new_string);
      replacements += count;
      continue;
    }
    const first = content.indexOf(edit.old_string);
    if (first < 0) {
      throw new Error(
        `old_string not found: ${JSON.stringify(edit.old_string.slice(0, 80))}`,
      );
    }
    if (content.indexOf(edit.old_string, first + 1) >= 0) {
      throw new Error(
        "old_string is not unique. Provide more surrounding context, or set replace_all=true.",
      );
    }
    content =
      content.slice(0, first) +
      edit.new_string +
      content.slice(first + edit.old_string.length);
    replacements += 1;
  }
  return { content, replacements };
}

/** 根据工具输入创建可审查且可安全提交的文件修改快照。 */
export async function prepareFileMutation({
  sessionId,
  toolCallId,
  toolName,
  input,
  cwd,
}: PrepareInput): Promise<PreparedFileMutation> {
  const key = fileMutationKey(sessionId, toolCallId);
  const prepared = preparedMutations.get(key);
  if (prepared) return prepared;
  const preparing = preparingMutations.get(key);
  if (preparing) return preparing;

  const task = prepareFileMutationOnce({
    sessionId,
    toolCallId,
    toolName,
    input,
    cwd,
  }).then((result) => {
    // clear 可能在异步读取期间使本次任务失效，旧任务不得回写已终结的审批。
    if (preparingMutations.get(key) === task) {
      preparedMutations.set(key, result);
    }
    return result;
  });
  preparingMutations.set(key, task);
  const cleanup = () => {
    if (preparingMutations.get(key) === task) {
      preparingMutations.delete(key);
    }
  };
  void task.then(cleanup, cleanup);
  return task;
}

async function prepareFileMutationOnce({
  sessionId,
  toolCallId,
  toolName,
  input,
  cwd,
}: PrepareInput): Promise<PreparedFileMutation> {
  const rawPath = typeof input.path === "string" ? input.path : "";
  if (!rawPath) throw new Error("file path is required");
  const requestedPath = resolvePath(rawPath, cwd);
  const safety = await checkWritableCanonical(
    requestedPath,
    native.canonicalize,
  );
  if (!safety.ok) throw new Error(safety.reason);
  const snapshot = await readTextSnapshot(safety.canonical);

  let after: string;
  let replacements = 0;
  if (toolName === "write_file") {
    if (typeof input.content !== "string") {
      throw new Error("file content is required");
    }
    after = input.content;
  } else {
    const edits = parseEdits(toolName, input);
    const applied = applyTextEdits(snapshot.content, edits);
    after = applied.content;
    replacements = applied.replacements;
  }

  const prepared: PreparedFileMutation = {
    sessionId,
    toolCallId,
    toolName,
    path: safety.canonical,
    before: snapshot.content,
    after,
    isNewFile: snapshot.isNewFile,
    version: snapshot.version,
    replacements,
  };
  return prepared;
}

/** 读取审批阶段已经生成的文件修改快照。 */
export function getPreparedFileMutation(
  sessionId: string,
  toolCallId: string,
): PreparedFileMutation | null {
  return preparedMutations.get(fileMutationKey(sessionId, toolCallId)) ?? null;
}

/** 清理已经终结或被拒绝的文件工具快照。 */
export function clearPreparedFileMutation(
  sessionId: string,
  toolCallId: string,
): void {
  const key = fileMutationKey(sessionId, toolCallId);
  preparedMutations.delete(key);
  preparingMutations.delete(key);
}

/** 判断工具状态是否已经终结，可以安全释放审批快照。 */
export function isTerminalFileMutationState(
  state: string | undefined,
): boolean {
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

/**
 * 提交已经审查的文件修改。
 * 路径重解析或后端版本条件不再成立时拒绝覆盖，成功后清理运行时快照。
 */
export async function commitPreparedFileMutation(
  prepared: PreparedFileMutation,
): Promise<void> {
  const safety = await checkWritableCanonical(
    prepared.path,
    native.canonicalize,
  );
  if (!safety.ok) throw new Error(safety.reason);
  if (normalizePath(safety.canonical) !== normalizePath(prepared.path)) {
    throw new Error("file path changed after approval");
  }
  const result = await native.writeFileChecked(
    prepared.path,
    prepared.after,
    prepared.version
      ? { type: "match", version: prepared.version }
      : { type: "missing" },
  );
  if (result.status === "conflict") {
    throw new Error(
      "file changed after approval; review the updated file again",
    );
  }
  clearPreparedFileMutation(prepared.sessionId, prepared.toolCallId);
}

function parseEdits(
  toolName: "edit" | "multi_edit",
  input: Record<string, unknown>,
): EditOperation[] {
  if (toolName === "edit") {
    return [
      {
        old_string:
          typeof input.old_string === "string" ? input.old_string : "",
        new_string:
          typeof input.new_string === "string" ? input.new_string : "",
        replace_all: input.replace_all === true,
      },
    ];
  }
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("at least one edit is required");
  }
  return input.edits.map((value) => {
    const edit = value as Record<string, unknown>;
    return {
      old_string: typeof edit.old_string === "string" ? edit.old_string : "",
      new_string: typeof edit.new_string === "string" ? edit.new_string : "",
      replace_all: edit.replace_all === true,
    };
  });
}

async function readTextSnapshot(path: string): Promise<TextSnapshot> {
  try {
    const result = await native.readFile(path);
    if (result.kind === "binary") throw new Error("binary file refused");
    if (result.kind === "toolarge") {
      throw new Error(`file too large (${result.size} bytes)`);
    }
    return {
      content: result.content,
      isNewFile: false,
      version: {
        revision: result.revision,
        size: result.size,
        mtime: result.mtime,
      },
    };
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    return { content: "", isNewFile: true, version: null };
  }
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let from = 0;
  let match = content.indexOf(needle, from);
  while (match >= 0) {
    count += 1;
    from = match + needle.length;
    match = content.indexOf(needle, from);
  }
  return count;
}

function isNotFoundError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("no such file") ||
    message.includes("not found") ||
    message.includes("os error 2")
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/$/, "");
}
