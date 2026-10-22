/**
 * 整文件删除时将原文作为只读正文，保留原始行号、查找与自动换行能力。
 * 删除装饰复用分栏原文侧的样式，避免统一视图的删除部件丢失行号。
 */

import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { SPLIT_DIFF_THEME } from "./diffTheme";
import { renderGitChangeOverview } from "./gitGutter";

export const deletedFileDiff: Extension = [
  EditorView.editorAttributes.of({ class: "cm-merge-a" }),
  EditorView.decorations.compute(["doc"], (state) => {
    const decorations: Range<Decoration>[] = [];
    for (let number = 1; number <= state.doc.lines; number++) {
      const line = state.doc.line(number);
      decorations.push(
        Decoration.line({ class: "cm-changedLine" }).range(line.from),
      );
      if (line.length > 0) {
        decorations.push(
          Decoration.mark({ class: "cm-changedText" }).range(
            line.from,
            line.to,
          ),
        );
      }
    }
    return Decoration.set(decorations, true);
  }),
  ViewPlugin.define((view) => {
    const rail = document.createElement("div");
    rail.className = "cm-changeOverview";
    rail.setAttribute("aria-hidden", "true");
    view.dom.append(rail);
    const render = () =>
      renderGitChangeOverview(view, rail, [
        { kind: "deleted", fromLine: 1, toLine: view.state.doc.lines },
      ]);
    render();
    return {
      update(update) {
        if (update.docChanged || update.geometryChanged) render();
      },
      destroy() {
        rail.remove();
      },
    };
  }),
  SPLIT_DIFF_THEME,
];
