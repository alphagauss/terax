import { foldNodeProp, syntaxTree } from "@codemirror/language";
import {
  EditorState,
  type Extension,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

function indentColumns(text: string, tabSize: number): number {
  let columns = 0;
  for (const char of text) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += tabSize - (columns % tabSize);
    else break;
  }
  return columns;
}

function firstIndentedLine(
  state: EditorState,
  firstLine: number,
  lastLine: number,
  tabSize: number,
): number | null {
  for (let number = firstLine; number <= lastLine; number += 1) {
    const text = state.doc.line(number).text;
    if (text.trim().length > 0) return indentColumns(text, tabSize);
  }
  return null;
}

export function syntaxBlockGuides(
  state: EditorState,
  firstVisibleLine: number,
  lastVisibleLine: number,
): Map<number, number[]> {
  const tabSize = state.facet(EditorState.tabSize);
  const columnsByLine = new Map<number, Set<number>>();
  const from = state.doc.line(firstVisibleLine).from;
  const to = state.doc.line(lastVisibleLine).to;

  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      const fold = ref.type.prop(foldNodeProp)?.(ref.node, state);
      if (!fold || fold.from >= fold.to) return;

      const headerLine = state.doc.lineAt(fold.from).number;
      const rangeLastLine = state.doc.lineAt(
        Math.max(fold.from, fold.to - 1),
      ).number;
      const firstBodyLine = headerLine + 1;
      if (firstBodyLine > rangeLastLine) return;

      const bodyIndent = firstIndentedLine(
        state,
        firstBodyLine,
        rangeLastLine,
        tabSize,
      );
      if (bodyIndent == null || bodyIndent === 0) return;

      const firstLine = Math.max(firstBodyLine, firstVisibleLine);
      const lastLine = Math.min(rangeLastLine, lastVisibleLine);
      for (let number = firstLine; number <= lastLine; number += 1) {
        const text = state.doc.line(number).text;
        if (
          text.trim().length > 0 &&
          indentColumns(text, tabSize) < bodyIndent
        ) {
          continue;
        }
        const columns = columnsByLine.get(number) ?? new Set<number>();
        columns.add(bodyIndent);
        columnsByLine.set(number, columns);
      }
    },
  });

  return new Map(
    [...columnsByLine].map(([line, columns]) => [
      line,
      [...columns].sort((a, b) => a - b),
    ]),
  );
}

export function guidePixelPositions(
  columns: readonly number[],
  baseIndent: number,
  characterWidth: number,
  linePaddingLeft: number,
): number[] {
  return columns.map(
    (column) =>
      linePaddingLeft + Math.max(0, column - baseIndent) * characterWidth,
  );
}

function guideBackground(positions: readonly number[]): string {
  return positions
    .map(
      (position) =>
        `linear-gradient(var(--cm-indent-guide-color), var(--cm-indent-guide-color)) ${position}px 0 / 1px 100% no-repeat`,
    )
    .join(", ");
}

function linePaddingLeft(view: EditorView): number {
  const line = view.contentDOM.querySelector<HTMLElement>(".cm-line");
  if (!line) return 0;
  const padding = Number.parseFloat(getComputedStyle(line).paddingLeft);
  return Number.isFinite(padding) ? padding : 0;
}

function buildDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const firstLine = state.doc.lineAt(view.viewport.from).number;
  const lastLine = state.doc.lineAt(view.viewport.to).number;
  const columnsByLine = syntaxBlockGuides(state, firstLine, lastLine);
  const characterWidth = view.defaultCharacterWidth;
  const paddingLeft = linePaddingLeft(view);
  let baseIndent = Number.POSITIVE_INFINITY;
  for (const columns of columnsByLine.values()) {
    for (const column of columns) baseIndent = Math.min(baseIndent, column);
  }
  const builder = new RangeSetBuilder<Decoration>();

  for (const [lineNumber, columns] of columnsByLine) {
    const line = state.doc.line(lineNumber);
    const positions = guidePixelPositions(
      columns,
      baseIndent,
      characterWidth,
      paddingLeft,
    );
    builder.add(
      line.from,
      line.from,
      Decoration.line({
        attributes: {
          class: "cm-indentGuideLine",
          style: `--cm-indent-guides: ${guideBackground(positions)}`,
        },
      }),
    );
  }
  return builder.finish();
}

export function indentGuides(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = buildDecorations(view);
        }

        update(update: ViewUpdate): void {
          if (
            update.docChanged ||
            update.viewportChanged ||
            update.geometryChanged ||
            syntaxTree(update.startState) !== syntaxTree(update.state)
          ) {
            this.decorations = buildDecorations(update.view);
          }
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    EditorView.theme({
      ".cm-line.cm-indentGuideLine": {
        position: "relative",
      },
      ".cm-line.cm-indentGuideLine::before": {
        content: '""',
        position: "absolute",
        inset: "0",
        background: "var(--cm-indent-guides)",
        pointerEvents: "none",
      },
      "&": {
        "--cm-indent-guide-color":
          "color-mix(in srgb, var(--foreground) 18%, transparent)",
      },
    }),
  ];
}
