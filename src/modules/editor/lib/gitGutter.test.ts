/**
 * 本文件测试编辑器 Git gutter 的 DOM 绘制结构。
 *
 * 锁定活动行样式与 Git 变更标记使用不同元素，避免背景和阴影互相覆盖。
 */

// @vitest-environment happy-dom

import { unifiedMergeView } from "@codemirror/merge";
import { EditorState, Text } from "@codemirror/state";
import { EditorView, highlightActiveLineGutter } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitChangeGutter,
  gitChangeOverview,
  renderGitChangeOverview,
  setQuickDiffBaseline,
} from "./gitGutter";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
});

describe("gitChangeGutter", () => {
  it.each([
    { original: "", modified: "new\nfile", kinds: ["added"] },
    {
      original: "one\nold\nthree",
      modified: "one\nnew\nthree",
      kinds: ["deleted", "added"],
    },
    { original: "one\ntwo\nthree", modified: "one\nthree", kinds: ["deleted"] },
  ])(
    "renders unified overview lanes for $kinds",
    ({ original, modified, kinds }) => {
      const parent = document.createElement("div");
      document.body.append(parent);
      view = new EditorView({
        parent,
        state: EditorState.create({
          doc: original,
          extensions: [
            unifiedMergeView({ original, mergeControls: false }),
            gitChangeOverview,
          ],
        }),
      });
      let scrollHeight = 200;
      Object.defineProperties(view.scrollDOM, {
        scrollHeight: { get: () => scrollHeight },
        clientHeight: { get: () => 100 },
      });
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: modified },
      });

      const rail = view.dom.querySelector<HTMLDivElement>(".cm-changeOverview");
      expect(rail?.hidden).toBe(false);
      expect(
        Array.from(rail?.children ?? [], (marker) => marker.className),
      ).toEqual(kinds.map((kind) => `cm-changeOverview-${kind}`));

      // 内容恢复基线后移除标记；重新产生差异但无纵向溢出时仍隐藏概览。
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: original },
      });
      expect(rail?.hidden).toBe(true);
      expect(rail?.children).toHaveLength(0);
      scrollHeight = 100;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: modified },
      });
      expect(rail?.hidden).toBe(true);
    },
  );

  it.each([
    {
      kind: "added",
      baseline: "",
      current: "new",
    },
    {
      kind: "added",
      baseline: "one\nthree",
      current: "one\ntwo\nthree",
    },
    {
      kind: "modified",
      baseline: "one\nold\nthree",
      current: "one\nnew\nthree",
    },
    {
      kind: "deleted",
      baseline: "one\ntwo\nthree",
      current: "one\nthree",
    },
  ])("keeps the $kind marker separate on the active line", (testCase) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const state = EditorState.create({
      doc: testCase.current,
      selection: { anchor: testCase.current.indexOf("\n") + 1 },
      extensions: [highlightActiveLineGutter(), gitChangeGutter],
    });
    view = new EditorView({ state, parent });

    view.dispatch({
      effects: setQuickDiffBaseline.of(testCase.baseline),
    });

    const gutterElement = view.dom.querySelector(
      ".cm-changeGutter .cm-gutterElement.cm-activeLineGutter",
    );
    expect(gutterElement).not.toBeNull();
    expect(
      gutterElement?.querySelector(`.cm-change-${testCase.kind}`),
    ).not.toBeNull();
    expect(
      gutterElement?.classList.contains(`cm-change-${testCase.kind}`),
    ).toBe(false);
  });

  it("renders modified overview ranges as adjacent deletion and addition lanes", () => {
    const rail = document.createElement("div");
    const scrollElement = document.createElement("div");
    Object.defineProperties(scrollElement, {
      scrollHeight: { value: 200 },
      clientHeight: { value: 100 },
    });
    const overviewView = {
      contentHeight: 100,
      state: { doc: Text.of(["one", "changed", "three"]) },
      lineBlockAt: () => ({ top: 20, height: 10 }),
    } as unknown as EditorView;

    renderGitChangeOverview(
      overviewView,
      rail,
      [{ kind: "modified", fromLine: 2, toLine: 2 }],
      scrollElement,
    );

    expect(rail.querySelector(".cm-changeOverview-deleted")).not.toBeNull();
    expect(rail.querySelector(".cm-changeOverview-added")).not.toBeNull();
    expect(rail.querySelector(".cm-changeOverview-modified")).toBeNull();
  });
});
