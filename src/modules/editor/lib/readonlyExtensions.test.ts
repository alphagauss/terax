/** 本文件验证只读编辑器仍可持有静态光标与键盘焦点。 */

// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  getDrawSelectionConfig,
} from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { FOCUSABLE_READONLY_EXTENSIONS } from "./extensions";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
});

describe("focusable readonly editor", () => {
  it("keeps the document immutable while exposing a non-blinking cursor", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({
      doc: "before\nafter",
      parent,
      extensions: [drawSelection(), ...FOCUSABLE_READONLY_EXTENSIONS],
    });

    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    expect(view.contentDOM.contentEditable).toBe("false");
    expect(view.contentDOM.tabIndex).toBe(0);
    expect(getDrawSelectionConfig(view.state).cursorBlinkRate).toBe(0);

    view.focus();
    expect(view.hasFocus).toBe(true);
  });
});
