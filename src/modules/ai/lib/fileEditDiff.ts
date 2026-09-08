/** 文件快照的行级差异计算，与编辑器一起按需加载，不进入主窗口启动依赖。 */
import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import {
  countLines,
  type FileEditStats,
  type FileEditSnapshot,
  type FileEditFile,
} from "@/modules/ai/lib/fileEdits";

/** 与只读 Diff 使用相同的修改区间和行数口径。 */
export function computeLineStats(
  original: string,
  proposed: string,
): FileEditStats {
  let added = 0;
  let removed = 0;
  const before = Text.of(original.split(/\r\n?|\n/));
  const after = Text.of(proposed.split(/\r\n?|\n/));
  // 使用行级区间，同一行中的多个字符修改只能计为一行。
  for (const change of Chunk.build(before, after)) {
    removed += countLines(
      before.sliceString(change.fromA, Math.min(change.toA, before.length)),
    );
    added += countLines(
      after.sliceString(change.fromB, Math.min(change.toB, after.length)),
    );
  }
  return { added, removed };
}

/** 同一文件按分段展示；已经恢复原状的连续修改不进入轮末卡片。 */
export function summarizeFileEdits(snapshot: FileEditSnapshot): FileEditFile[] {
  const files = new Map<string, FileEditFile>();
  for (const segment of snapshot.files) {
    if (segment.before === segment.after && !segment.isNewFile) continue;
    const file = files.get(segment.identity) ?? {
      path: segment.path,
      identity: segment.identity,
      segments: [],
      added: 0,
      removed: 0,
    };
    const stats = computeLineStats(segment.before, segment.after);
    file.added += stats.added;
    file.removed += stats.removed;
    file.segments.push(segment);
    files.set(segment.identity, file);
  }
  return [...files.values()];
}
