/**
 * 本文件测试编辑器 Quick Diff 的完整构建与 transaction 增量更新。
 *
 * 锁定新增、修改、删除、行号移动和增量结果与完整重算一致等核心不变量。
 */

import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  buildQuickDiff,
  type QuickDiffRange,
  updateQuickDiff,
} from "./quickDiff";

function text(value: string): Text {
  return Text.of(value.split("\n"));
}

function ranges(original: string, modified: string): readonly QuickDiffRange[] {
  return buildQuickDiff(text(original), text(modified)).ranges;
}

describe("buildQuickDiff", () => {
  it("classifies added, modified and deleted lines", () => {
    expect(ranges("a\nb\nc", "a\ninserted\nb\nc")).toEqual([
      { kind: "added", fromLine: 2, toLine: 2 },
    ]);
    expect(ranges("a\nb\nc", "a\nchanged\nc")).toEqual([
      { kind: "modified", fromLine: 2, toLine: 2 },
    ]);
    expect(ranges("a\nb\nc", "a\nc")).toEqual([
      { kind: "deleted", fromLine: 2, toLine: 2 },
    ]);
  });

  it("pairs replacement lines and preserves unmatched additions", () => {
    expect(ranges("a\nb\nc\nd", "a\nx\ny\nz\nd")).toEqual([
      { kind: "modified", fromLine: 2, toLine: 3 },
      { kind: "added", fromLine: 4, toLine: 4 },
    ]);
  });

  it("classifies character insertion and deletion as line modifications", () => {
    expect(ranges("abc", "abxc")).toEqual([
      { kind: "modified", fromLine: 1, toLine: 1 },
    ]);
    expect(ranges("abc", "ac")).toEqual([
      { kind: "modified", fromLine: 1, toLine: 1 },
    ]);
  });

  it("keeps the previous last line modified when appending without a newline", () => {
    expect(ranges("a\nb", "a\nb\nc")).toEqual([
      { kind: "modified", fromLine: 2, toLine: 2 },
      { kind: "added", fromLine: 3, toLine: 3 },
    ]);
  });

  it("marks a new document as added and an emptied document as deleted", () => {
    expect(ranges("", "first\nsecond")).toEqual([
      { kind: "added", fromLine: 1, toLine: 2 },
    ]);
    expect(ranges("first\nsecond", "")).toEqual([
      { kind: "deleted", fromLine: 1, toLine: 1 },
    ]);
  });
});

describe("updateQuickDiff", () => {
  it("moves existing changes after a top-of-file insertion", () => {
    const baseline = text("a\nb\nc\nd\ne");
    const currentText = text("a\nb\nchanged\nd\ne");
    const current = buildQuickDiff(baseline, currentText);
    const changes = ChangeSet.of(
      { from: 0, insert: "top\n" },
      currentText.length,
    );
    const modified = changes.apply(currentText);
    const incremental = updateQuickDiff(current, modified, changes.desc);
    const rebuilt = buildQuickDiff(baseline, modified);

    expect(incremental.ranges).toEqual(rebuilt.ranges);
    expect(
      incremental.ranges[incremental.ranges.length - 1]?.toLine,
    ).toBeGreaterThanOrEqual(4);
  });

  it("keeps consecutive transaction updates equivalent to a full rebuild", () => {
    const baseline = text("one\ntwo\nthree\nfour");
    let modified = baseline;
    let snapshot = buildQuickDiff(baseline, modified);
    for (const spec of [
      { from: 4, to: 7, insert: "second" },
      { from: 0, insert: "zero\n" },
    ]) {
      const changes = ChangeSet.of(spec, modified.length);
      modified = changes.apply(modified);
      snapshot = updateQuickDiff(snapshot, modified, changes.desc);
    }

    expect(snapshot.ranges).toEqual(buildQuickDiff(baseline, modified).ranges);
  });

  it("disables decoration work above the bounded input size", () => {
    const huge = text("x".repeat(2 * 1024 * 1024));
    const snapshot = buildQuickDiff(text("baseline"), huge);

    expect(snapshot.disabled).toBe(true);
    expect(snapshot.chunks).toEqual([]);
    expect(snapshot.ranges).toEqual([]);
  });
});
