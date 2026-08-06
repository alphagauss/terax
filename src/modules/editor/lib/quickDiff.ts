/**
 * 本文件实现基于 HEAD 文本基线的增量 Quick Diff 计算。
 *
 * 只处理内存文本与行变更范围，不访问 Git、文件系统或 IPC。复杂 diff 超过计算上限时返回空装饰，避免阻塞编辑器输入。
 */

import { Chunk, type DiffConfig } from "@codemirror/merge";
import type { ChangeDesc, Text } from "@codemirror/state";

const QUICK_DIFF_MAX_CHARS = 2 * 1024 * 1024;
const QUICK_DIFF_CONFIG: DiffConfig = { scanLimit: 500, timeout: 50 };

export type QuickDiffKind = "added" | "modified" | "deleted";

export type QuickDiffRange = {
  kind: QuickDiffKind;
  fromLine: number;
  toLine: number;
};

export type QuickDiffSnapshot = {
  baseline: Text;
  chunks: readonly Chunk[];
  ranges: readonly QuickDiffRange[];
  disabled: boolean;
};

function lineSpan(text: Text, from: number, end: number) {
  const safeFrom = Math.max(0, Math.min(from, text.length));
  const safeEnd = Math.max(safeFrom, Math.min(end, text.length));
  const fromLine = text.lineAt(safeFrom).number;
  const toLine = text.lineAt(safeEnd).number;
  return { fromLine, count: toLine - fromLine + 1 };
}

function setKind(
  kinds: Map<number, QuickDiffKind>,
  line: number,
  kind: QuickDiffKind,
): void {
  const previous = kinds.get(line);
  if (previous === "modified" || (previous === "added" && kind === "deleted")) {
    return;
  }
  kinds.set(line, kind);
}

/** 将 CodeMirror diff chunks 转换为 gutter 和 overview 共用的连续行范围。 */
export function rangesFromChunks(
  baseline: Text,
  modified: Text,
  chunks: readonly Chunk[],
): QuickDiffRange[] {
  if (chunks.some((chunk) => !chunk.precise)) return [];

  const kinds = new Map<number, QuickDiffKind>();
  for (const chunk of chunks) {
    // Chunk 已按整行扩展。只有一侧的整行范围为空时，才能判定为纯新增或纯删除；
    // 字符级插入和删除的两侧范围都非空，必须显示为修改。
    const hasOriginal = baseline.length > 0 && chunk.fromA !== chunk.toA;
    const hasModified = modified.length > 0 && chunk.fromB !== chunk.toB;

    if (!hasOriginal && hasModified) {
      const span = lineSpan(modified, chunk.fromB, chunk.endB);
      for (let offset = 0; offset < span.count; offset++) {
        setKind(kinds, span.fromLine + offset, "added");
      }
      continue;
    }

    if (hasOriginal && !hasModified) {
      const line = modified.lineAt(
        Math.max(0, Math.min(chunk.fromB, modified.length)),
      ).number;
      setKind(kinds, line, "deleted");
      continue;
    }

    if (!hasOriginal || !hasModified) continue;
    const originalSpan = lineSpan(baseline, chunk.fromA, chunk.endA);
    const modifiedSpan = lineSpan(modified, chunk.fromB, chunk.endB);
    const modifiedCount = Math.min(originalSpan.count, modifiedSpan.count);
    for (let offset = 0; offset < modifiedCount; offset++) {
      setKind(kinds, modifiedSpan.fromLine + offset, "modified");
    }
    for (let offset = modifiedCount; offset < modifiedSpan.count; offset++) {
      setKind(kinds, modifiedSpan.fromLine + offset, "added");
    }
    if (originalSpan.count > modifiedSpan.count) {
      setKind(
        kinds,
        Math.min(modified.lines, modifiedSpan.fromLine + modifiedSpan.count),
        "deleted",
      );
    }
  }

  const ranges: QuickDiffRange[] = [];
  for (const [line, kind] of [...kinds].sort((a, b) => a[0] - b[0])) {
    const previous = ranges[ranges.length - 1];
    if (previous?.kind === kind && previous.toLine + 1 === line) {
      previous.toLine = line;
    } else {
      ranges.push({ kind, fromLine: line, toLine: line });
    }
  }
  return ranges;
}

function snapshot(
  baseline: Text,
  modified: Text,
  chunks: readonly Chunk[],
  disabled: boolean,
): QuickDiffSnapshot {
  return {
    baseline,
    chunks,
    ranges: disabled ? [] : rangesFromChunks(baseline, modified, chunks),
    disabled,
  };
}

/** 构建一份完整 Quick Diff；仅在首次取得或替换 HEAD 基线时调用。 */
export function buildQuickDiff(
  baseline: Text,
  modified: Text,
): QuickDiffSnapshot {
  const disabled = baseline.length + modified.length > QUICK_DIFF_MAX_CHARS;
  const chunks = disabled
    ? []
    : Chunk.build(baseline, modified, QUICK_DIFF_CONFIG);
  return snapshot(baseline, modified, chunks, disabled);
}

/** 使用 CodeMirror transaction 增量更新当前文档一侧的 Quick Diff。 */
export function updateQuickDiff(
  current: QuickDiffSnapshot,
  modified: Text,
  changes: ChangeDesc,
): QuickDiffSnapshot {
  const disabled =
    current.baseline.length + modified.length > QUICK_DIFF_MAX_CHARS;
  if (disabled || current.disabled) {
    return disabled
      ? snapshot(current.baseline, modified, [], true)
      : buildQuickDiff(current.baseline, modified);
  }
  const chunks = Chunk.updateB(
    current.chunks,
    current.baseline,
    modified,
    changes,
    QUICK_DIFF_CONFIG,
  );
  return snapshot(current.baseline, modified, chunks, false);
}
