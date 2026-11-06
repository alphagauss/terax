/**
 * Git 详情先按行对齐两份文本，避免全文字符比较将分散的改动合并成大块。
 */

import { Change, diff, type DiffConfig } from "@codemirror/merge";
import { diffLines } from "diff";

const LINE_DIFF_TIMEOUT_MS = 25;
const CHARACTER_DIFF_CONFIG = { scanLimit: 500, timeout: 5 };
const MAX_REFINEMENT_CHARS = 512;

function lineFirstDiff(original: string, modified: string): readonly Change[] {
  const deadline = Date.now() + LINE_DIFF_TIMEOUT_MS;
  const parts = diffLines(original, modified, {
    timeout: LINE_DIFF_TIMEOUT_MS,
  });
  if (!parts) return diff(original, modified, CHARACTER_DIFF_CONFIG);

  const changes: Change[] = [];
  let fromA = 0;
  let fromB = 0;
  let toA = 0;
  let toB = 0;

  function addChange() {
    const removed = toA - fromA;
    const added = toB - fromB;
    if (removed === 0 && added === 0) return;

    // 字符级细化只在小替换块中进行，并与行级计算共享时间预算。
    const remaining = deadline - Date.now();
    if (
      removed &&
      added &&
      removed + added <= MAX_REFINEMENT_CHARS &&
      remaining > 0
    ) {
      const refined = diff(
        original.slice(fromA, toA),
        modified.slice(fromB, toB),
        {
          ...CHARACTER_DIFF_CONFIG,
          timeout: Math.min(remaining, CHARACTER_DIFF_CONFIG.timeout),
        },
      );
      for (const change of refined) {
        changes.push(
          new Change(
            fromA + change.fromA,
            fromA + change.toA,
            fromB + change.fromB,
            fromB + change.toB,
          ),
        );
      }
    } else {
      changes.push(new Change(fromA, toA, fromB, toB));
    }
  }

  for (const part of parts) {
    const length = part.value.length;
    if (part.removed) {
      toA += length;
    } else if (part.added) {
      toB += length;
    } else {
      addChange();
      toA += length;
      toB += length;
      fromA = toA;
      fromB = toB;
    }
  }
  addChange();
  return changes;
}

export const GIT_DIFF_CONFIG: DiffConfig = { override: lineFirstDiff };
