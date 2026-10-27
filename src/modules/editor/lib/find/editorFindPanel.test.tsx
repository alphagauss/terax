// @vitest-environment happy-dom

import { applyTheme, clearTheme } from "@/modules/theme/applyTheme";
import { modern } from "@/modules/theme/themes/modern";
import { openSearchPanel, search } from "@codemirror/search";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSharedExtensions } from "../extensions";
import { createEditorFindPanel } from "./editorFindPanel";

type WidgetProps = ComponentProps<
  typeof import("@/modules/find").FindReplaceWidget
>;

const widget = vi.hoisted(() => ({ props: null as WidgetProps | null }));

vi.mock("@/modules/find", () => ({
  FIND_PRESENCE_MS: 0,
  FindReplaceWidget: (props: WidgetProps) => {
    widget.props = props;
    return null;
  },
}));

let view: EditorView;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => view?.destroy());
  document.body.replaceChildren();
  widget.props = null;
  vi.unstubAllGlobals();
  clearTheme();
});

async function openFind(doc: string, anchor = 0, head = anchor) {
  await act(async () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: { anchor, head },
        extensions: [search({ createPanel: createEditorFindPanel })],
      }),
    });
    openSearchPanel(view);
  });
}

function props(): WidgetProps {
  if (!widget.props) throw new Error("Find widget is not mounted");
  return widget.props;
}

function selectedMatch() {
  return view.contentDOM.querySelector(".cm-searchMatch-selected");
}

describe("editor find panel", () => {
  it("updates match colors from the shared theme without changing the current selection", async () => {
    await openFind("one two one");
    await act(async () => {
      view.dispatch({
        effects: StateEffect.appendConfig.of(buildSharedExtensions()),
      });
      props().onQueryChange("one");
    });
    const current = selectedMatch();
    const other = view.contentDOM.querySelector(
      ".cm-searchMatch:not(.cm-searchMatch-selected)",
    );
    expect(current).not.toBeNull();
    expect(other).not.toBeNull();
    if (!current || !other) return;

    for (const mode of ["dark", "light"] as const) {
      applyTheme(modern, mode);
      expect(getComputedStyle(current).backgroundColor).toBe(
        modern.variants[mode]?.colors?.searchCurrentMatchBackground,
      );
      expect(getComputedStyle(other).backgroundColor).toBe(
        modern.variants[mode]?.colors?.searchMatchBackground,
      );
      expect(view.state.selection.main).toMatchObject({ from: 0, to: 3 });
    }
  });

  it("highlights the current match immediately and navigates on the first click", async () => {
    await openFind("one two one");

    await act(async () => {
      props().onQueryChange("one");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });

    expect(view.state.selection.main).toMatchObject({ from: 0, to: 3 });
    expect(selectedMatch()?.textContent).toBe("one");
    expect(view.contentDOM.querySelectorAll(".cm-searchMatch")).toHaveLength(2);
    expect(props().result).toMatchObject({ current: 1, total: 2 });

    await act(async () => props().onNext?.());
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 11 });
    expect(selectedMatch()?.textContent).toBe("one");
    expect(props().result).toMatchObject({ current: 2, total: 2 });

    await act(async () => props().onPrevious?.());
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 3 });
  });

  it("keeps the current occurrence while extending the search text", async () => {
    await openFind("one two one", 4);

    await act(async () => props().onQueryChange("o"));
    expect(view.state.selection.main).toMatchObject({ from: 6, to: 7 });

    await act(async () => props().onQueryChange("on"));
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 10 });

    await act(async () => props().onQueryChange("one"));
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 11 });
    expect(selectedMatch()?.textContent).toBe("one");
  });

  it.each([
    { doc: "one two one", anchor: 11 },
    { doc: "one", anchor: 1 },
  ])(
    "wraps to the first full match from cursor $anchor",
    async ({ doc, anchor }) => {
      await openFind(doc, anchor);
      await act(async () => props().onQueryChange("one"));

      expect(view.state.selection.main).toMatchObject({ from: 0, to: 3 });
      expect(selectedMatch()?.textContent).toBe("one");
    },
  );

  it("selects a new match after changing search options", async () => {
    await openFind("ONE one");
    await act(async () => props().onQueryChange("one"));
    await act(async () =>
      props().onOptionsChange?.({
        caseSensitive: true,
        wholeWord: false,
        regexp: false,
      }),
    );

    expect(view.state.selection.main).toMatchObject({ from: 4, to: 7 });
    expect(selectedMatch()?.textContent).toBe("one");
  });

  it("selects within the original selection when search scope is enabled", async () => {
    await openFind("one two one", 0, 3);
    await act(async () => props().onQueryChange("one"));
    await act(async () => props().onNext?.());
    await act(async () => props().selection?.onToggle());

    expect(view.state.selection.main).toMatchObject({ from: 0, to: 3 });
    expect(view.contentDOM.querySelectorAll(".cm-searchMatch")).toHaveLength(1);
  });

  it("preserves selection when editing replacement text or searching without matches", async () => {
    await openFind("one two one", 4);
    await act(async () => props().onQueryChange("one"));
    await act(async () => view.dispatch({ selection: { anchor: 4 } }));
    await act(async () => props().replace?.onChange("value"));
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 4 });

    await act(async () => props().onQueryChange("missing"));
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 4 });
    expect(selectedMatch()).toBeNull();

    await act(async () => props().onQueryChange(""));
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 4 });
  });
});
