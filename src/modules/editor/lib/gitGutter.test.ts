/**
 * 本文件测试 Git diff 行分类与变更概览 rail 的显示条件。
 *
 * 锁定无纵向溢出时不得显示 rail，以及新增、修改和删除行的解析规则。
 */

import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  gitChangesForDiff,
  hasVerticalScroll,
  parseUnifiedDiff,
  renderGitChangeOverview,
} from "./gitGutter";

describe("hasVerticalScroll", () => {
  it("returns false when all content fits in the viewport", () => {
    const element = { scrollHeight: 400, clientHeight: 400 } as HTMLElement;

    expect(hasVerticalScroll(element)).toBe(false);
  });

  it("returns true when content exceeds the viewport", () => {
    const element = { scrollHeight: 401, clientHeight: 400 } as HTMLElement;

    expect(hasVerticalScroll(element)).toBe(true);
  });

  it("hides the Git overview rail when changed content does not scroll", () => {
    const scrollDOM = {
      scrollHeight: 400,
      clientHeight: 400,
    } as HTMLElement;
    const view = { scrollDOM } as EditorView;
    let replaceCount = 0;
    const rail = {
      hidden: false,
      replaceChildren: () => {
        replaceCount++;
      },
    } as unknown as HTMLDivElement;

    renderGitChangeOverview(view, rail, {
      added: new Set([1]),
      modified: new Set(),
      deleted: new Set(),
    });

    expect(rail.hidden).toBe(true);
    expect(replaceCount).toBe(1);
  });
});

describe("parseUnifiedDiff", () => {
  it("returns nothing for empty input", () => {
    const c = parseUnifiedDiff("");
    expect(c.added.size + c.modified.size + c.deleted.size).toBe(0);
  });

  it("marks a pure insertion as added on the new-file line", () => {
    // Insert one line after line 1 (context), so the new line 2 is added.
    const diff = [
      "diff --git a/f b/f",
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,3 @@",
      " a",
      "+inserted",
      " b",
      "",
    ].join("\n");
    const c = parseUnifiedDiff(diff);
    expect([...c.added]).toEqual([2]);
    expect(c.modified.size).toBe(0);
    expect(c.deleted.size).toBe(0);
  });

  it("marks a replaced line as modified", () => {
    // Line 2 replaced: one deletion immediately followed by one addition.
    const diff = ["@@ -1,3 +1,3 @@", " a", "-old", "+new", " c", ""].join("\n");
    const c = parseUnifiedDiff(diff);
    expect([...c.modified]).toEqual([2]);
    expect(c.added.size).toBe(0);
  });

  it("marks a boundary for a pure deletion", () => {
    // Delete line 2; the deletion boundary lands on the following new-file line.
    const diff = ["@@ -1,3 +1,2 @@", " a", "-gone", " c", ""].join("\n");
    const c = parseUnifiedDiff(diff);
    expect([...c.deleted]).toEqual([2]);
    expect(c.added.size + c.modified.size).toBe(0);
  });

  it("marks a deletion at end of file", () => {
    const diff = ["@@ -1,2 +1,1 @@", " a", "-gone"].join("\n");
    const c = parseUnifiedDiff(diff);
    expect([...c.deleted]).toEqual([1]);
  });

  it("does not treat added content beginning with '-' as a header", () => {
    const diff = ["@@ -1,1 +1,2 @@", " a", "+- a bullet", ""].join("\n");
    const c = parseUnifiedDiff(diff);
    expect([...c.added]).toEqual([2]);
  });
});

describe("gitChangesForDiff", () => {
  it("marks an untracked file when git does not return a patch", () => {
    const changes = gitChangesForDiff("", "", "first\nsecond\n");
    expect([...changes.added]).toEqual([1, 2]);
  });

  it("marks a deleted file when git does not return a patch", () => {
    const changes = gitChangesForDiff("", "content\n", "");
    expect([...changes.deleted]).toEqual([1]);
  });
});
