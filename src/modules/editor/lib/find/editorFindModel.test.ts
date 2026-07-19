import { SearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  collectFindMatches,
  createEditorFindQuery,
  findMatchPosition,
} from "./editorFindModel";

const value = {
  search: "one",
  replace: "",
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  literal: false,
};

describe("editor find model", () => {
  it("keeps selection scope in the query value and clears it explicitly", () => {
    const state = EditorState.create({ doc: "one two one" });
    const scoped = createEditorFindQuery(value, [{ from: 0, to: 3 }]);
    const unscoped = createEditorFindQuery(value, null);

    expect(collectFindMatches(state, scoped, 100).ranges).toHaveLength(1);
    expect(collectFindMatches(state, unscoped, 100).ranges).toHaveLength(2);
    expect(scoped.test).toBeTypeOf("function");
    expect(unscoped.test).toBeUndefined();
  });

  it("caps count work and reports a limited result", () => {
    const state = EditorState.create({ doc: "a a a a" });
    const query = new SearchQuery({ search: "a" });
    const matches = collectFindMatches(state, query, 2);

    expect(matches.ranges).toHaveLength(2);
    expect(matches.limited).toBe(true);
  });

  it("derives the current result without rescanning the document", () => {
    const state = EditorState.create({
      doc: "one two one",
      selection: { anchor: 8, head: 11 },
    });
    const matches = collectFindMatches(
      state,
      new SearchQuery({ search: "one" }),
      100,
    );

    expect(findMatchPosition(matches.ranges, state.selection.main)).toBe(2);
  });

  it("does not invent a wrapped position beyond a limited count", () => {
    const state = EditorState.create({
      doc: "a a a a",
      selection: { anchor: 6 },
    });
    const matches = collectFindMatches(
      state,
      new SearchQuery({ search: "a" }),
      2,
    );

    expect(
      findMatchPosition(matches.ranges, state.selection.main, matches.limited),
    ).toBe(0);
  });
});
