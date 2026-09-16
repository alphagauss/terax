/**
 * 本文件测试编辑器 Git gutter 的 DOM 绘制结构。
 *
 * 锁定活动行样式与 Git 变更标记使用不同元素，避免背景和阴影互相覆盖。
 */

// @vitest-environment happy-dom

import { EditorState, Text } from "@codemirror/state";
import { EditorView, highlightActiveLineGutter } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitChangeGutter,
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
