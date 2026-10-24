/**
 * 文件编辑的展示事实与轮内归并。预估仅在内存，提交快照独立于模型输入。
 * 连续修改合并首尾；基线不连续时保留分段，避免把其他写入归因给 Agent。
 */

export type FileEditStats = { added: number; removed: number };
export type FileEditCall = FileEditStats & {
  toolCallId: string;
  taskId?: string;
  uncertain?: boolean;
};
export type FileEditSegment = {
  path: string;
  identity: string;
  before: string;
  after: string;
  isNewFile: boolean;
};
export type FileEditSnapshot = {
  kind: "file-edits";
  calls: FileEditCall[];
  files: FileEditSegment[];
  uncertainPaths: string[];
};
export type TurnFileEdits = FileEditSnapshot & { turnId: string };
export type FileEditsOpenInput = {
  sessionId: string;
  edits: TurnFileEdits;
  selectedIdentity: string;
};
export type FileEditFile = FileEditStats & {
  path: string;
  identity: string;
  segments: FileEditSegment[];
};

export function fileEditCallKey(toolCallId: string, taskId?: string): string {
  return JSON.stringify([taskId ?? "", toolCallId]);
}

export function countLines(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count + (text.endsWith("\n") ? 0 : 1);
}

export function emptyFileEdits(): FileEditSnapshot {
  return { kind: "file-edits", calls: [], files: [], uncertainPaths: [] };
}

/** 合并已确认快照，重复调用幂等，文件按真实提交顺序归并。 */
export function mergeFileEdits(
  batches: readonly FileEditSnapshot[],
): FileEditSnapshot {
  const result = emptyFileEdits();
  const calls = new Map<string, FileEditCall>();
  const latest = new Map<string, FileEditSegment>();
  for (const batch of batches) {
    if (
      batch.calls.length &&
      batch.calls.every((call) =>
        calls.has(fileEditCallKey(call.toolCallId, call.taskId)),
      )
    )
      continue;
    for (const call of batch.calls)
      calls.set(fileEditCallKey(call.toolCallId, call.taskId), call);
    for (const file of batch.files) {
      const previous = latest.get(file.identity);
      if (previous && previous.after === file.before)
        previous.after = file.after;
      else {
        const segment = { ...file };
        result.files.push(segment);
        latest.set(file.identity, segment);
      }
    }
    for (const path of batch.uncertainPaths) {
      if (!result.uncertainPaths.includes(path))
        result.uncertainPaths.push(path);
    }
  }
  result.calls = [...calls.values()];
  return result;
}

/** 仅依据已经收到的参数估算编辑规模，不读取文件或执行替换。 */
export function estimateFileEdit(
  toolName: string,
  input: unknown,
): FileEditStats {
  const value = input as
    | {
        content?: unknown;
        edits?: Array<{ old_text?: unknown; new_text?: unknown }>;
      }
    | undefined;
  if (toolName === "write_file") {
    return {
      added: typeof value?.content === "string" ? countLines(value.content) : 0,
      removed: 0,
    };
  }
  const stats = { added: 0, removed: 0 };
  if (!Array.isArray(value?.edits)) return stats;
  for (const edit of value.edits) {
    if (typeof edit?.old_text === "string")
      stats.removed += countLines(edit.old_text);
    if (typeof edit?.new_text === "string")
      stats.added += countLines(edit.new_text);
  }
  return stats;
}

/** 忽略损坏的展示记录，不影响会话正文与模型历史恢复。 */
export function isFileEditSnapshot(value: unknown): value is FileEditSnapshot {
  if (!value || typeof value !== "object") return false;
  const data = value as FileEditSnapshot;
  const count = (n: unknown) =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  return (
    data.kind === "file-edits" &&
    Array.isArray(data.calls) &&
    data.calls.every(
      (call) =>
        call &&
        typeof call.toolCallId === "string" &&
        (call.taskId === undefined || typeof call.taskId === "string") &&
        count(call.added) &&
        count(call.removed) &&
        (call.uncertain === undefined || typeof call.uncertain === "boolean"),
    ) &&
    Array.isArray(data.files) &&
    data.files.every(
      (file) =>
        file &&
        typeof file.path === "string" &&
        typeof file.identity === "string" &&
        typeof file.before === "string" &&
        typeof file.after === "string" &&
        typeof file.isNewFile === "boolean",
    ) &&
    Array.isArray(data.uncertainPaths) &&
    data.uncertainPaths.every((path) => typeof path === "string")
  );
}
