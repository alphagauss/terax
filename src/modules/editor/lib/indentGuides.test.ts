import { javascript } from "@codemirror/lang-javascript";
import { pythonLanguage } from "@codemirror/lang-python";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { guidePixelPositions, syntaxBlockGuides } from "./indentGuides";

function pythonGuides(doc: string): Record<number, number[]> {
  const state = EditorState.create({ doc, extensions: [pythonLanguage] });
  return Object.fromEntries(syntaxBlockGuides(state, 1, state.doc.lines));
}

describe("syntaxBlockGuides", () => {
  it("draws guides only for foldable Python syntax blocks", () => {
    const doc = [
      "class Example:",
      "    def run(self):",
      "        value = 1",
      "        if value:",
      "            print(value)",
      "        return value",
      "",
    ].join("\n");

    expect(pythonGuides(doc)).toEqual({
      2: [4],
      3: [4, 8],
      4: [4, 8],
      5: [4, 8, 12],
      6: [4, 8],
    });
  });

  it("includes bracketed containers but stops before their closing line", () => {
    const doc = [
      "def values():",
      "    result = {",
      '        "one": 1,',
      "    }",
      "    return result",
      "",
    ].join("\n");

    expect(pythonGuides(doc)).toEqual({
      2: [4],
      3: [4, 8],
      4: [4],
      5: [4],
    });
  });

  it("does not treat ordinary continuation indentation as a block", () => {
    const doc = [
      "def total():",
      "    value = one + \\",
      "        two",
      "    return value",
      "",
    ].join("\n");

    expect(pythonGuides(doc)).toEqual({
      2: [4],
      3: [4],
      4: [4],
    });
  });

  it("keeps ancestor guides when their headers are above the viewport", () => {
    const doc = [
      "class Example:",
      "    def run(self):",
      "        if self.ready:",
      "            prepare()",
      "            execute()",
      "        return True",
      "",
    ].join("\n");
    const state = EditorState.create({ doc, extensions: [pythonLanguage] });

    expect(Object.fromEntries(syntaxBlockGuides(state, 5, 6))).toEqual({
      5: [4, 8, 12],
      6: [4, 8],
    });
  });

  it("uses the same semantic columns for two-space TypeScript blocks", () => {
    const doc = [
      "function run() {",
      "  if (ready) {",
      "    execute();",
      "  }",
      "}",
    ].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [javascript({ typescript: true })],
    });

    expect(
      Object.fromEntries(syntaxBlockGuides(state, 1, state.doc.lines)),
    ).toEqual({
      2: [2],
      3: [2, 4],
      4: [2],
    });
  });
});

describe("guidePixelPositions", () => {
  it("uses CodeMirror's measured character width and line padding", () => {
    expect(guidePixelPositions([4, 8, 12], 4, 7.5, 6)).toEqual([6, 36, 66]);
    expect(guidePixelPositions([2, 4, 6], 2, 7.5, 6)).toEqual([6, 21, 36]);
  });
});
