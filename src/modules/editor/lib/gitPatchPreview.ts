/**
 * 将 Git 补丁渲染为只读正文，按原始行号展开已加载版本中的上下文。
 */

import { diff } from "@codemirror/merge";
import { EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  WidgetType,
} from "@codemirror/view";
import { parsePatch } from "diff";
import { UNIFIED_DIFF_THEME } from "./diffTheme";
import { externalChanges } from "./externalChanges";

const CONTEXT_STEP = 10;
const ADDED_LINE = "cm-changedLine cm-gitPatchAdded";
const REMOVED_LINE = "cm-gitPatchRemoved";

type PatchLine = {
  text: string;
  oldLine?: number;
  newLine?: number;
  className?: string;
  gap?: number;
  marks?: { from: number; to: number }[];
};

class ExpandContextWidget extends WidgetType {
  constructor(
    private readonly gap: number,
    private readonly label: string,
    private readonly expand: (gap: number) => void,
  ) {
    super();
  }

  eq(other: ExpandContextWidget) {
    return (
      this.gap === other.gap &&
      this.label === other.label &&
      this.expand === other.expand
    );
  }

  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-gitPatchExpand";
    button.setAttribute("aria-label", this.label);
    button.textContent = "…";
    button.addEventListener("click", () => this.expand(this.gap));
    return button;
  }
}

class PatchLineNumber extends GutterMarker {
  constructor(private readonly number: number) {
    super();
  }

  eq(other: PatchLineNumber) {
    return this.number === other.number;
  }

  toDOM() {
    return document.createTextNode(String(this.number));
  }
}

function sourceLines(text: string) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** 解析单文件补丁并保存两侧行索引，展开时无需重读文件。 */
export function prepareGitPatchPreview(
  patch: string,
  original: string,
  modified: string,
) {
  let files: ReturnType<typeof parsePatch>;
  try {
    files = parsePatch(patch);
  } catch {
    return null;
  }
  const [file] = files;
  if (files.length !== 1 || !file || file.isBinary || !file.hunks.length) {
    return null;
  }
  return {
    snapshotId: Symbol(),
    hunks: file.hunks,
    original: sourceLines(original),
    modified: sourceLines(modified),
  };
}

/** 在有限的局部行内比较中突出替换的内容，并按需加入上下文。 */
export function buildGitPatchPreview(
  source: NonNullable<ReturnType<typeof prepareGitPatchPreview>>,
  expanded: ReadonlyMap<number, number> | undefined,
  expand: (gap: number) => void,
  expandLabel: string,
): { text: string; extensions: Extension } {
  const { hunks, original, modified } = source;
  const lines: PatchLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  function addGap(gap: number, oldEnd: number, newEnd: number) {
    const count = oldEnd - oldLine;
    const newCount = newEnd - newLine;
    if (count !== newCount) {
      if (count > 0 || newCount > 0) {
        lines.push({ text: "…", className: "cm-gitPatchAnnotation" });
      }
      return;
    }
    if (count <= 0) return;
    const betweenHunks = gap > 0 && gap < hunks.length;
    const reveal =
      (expanded?.get(gap) ?? 0) *
      (betweenHunks ? CONTEXT_STEP / 2 : CONTEXT_STEP);
    const head = gap > 0 ? Math.min(reveal, count) : 0;
    const tail = gap < hunks.length ? Math.min(reveal, count - head) : 0;

    function rows(from: number, to: number) {
      const result: PatchLine[] = [];
      for (let offset = from; offset < to; offset++) {
        const oldNumber = oldLine + offset;
        const newNumber = newLine + offset;
        const text = original[oldNumber - 1];
        // 补丁和工作区正文分开读取，只有两侧内容一致才作为未改动行展示。
        if (text === undefined || text !== modified[newNumber - 1]) return null;
        result.push({ text, oldLine: oldNumber, newLine: newNumber });
      }
      return result;
    }

    const before = rows(0, head);
    const after = rows(count - tail, count);
    if (!before || !after) {
      lines.push({ text: "…", className: "cm-gitPatchAnnotation" });
      return;
    }
    for (const line of before) lines.push(line);
    if (head + tail < count) lines.push({ text: "…", gap });
    for (const line of after) lines.push(line);
  }

  const deadline = Date.now() + 20;
  for (const [
    gap,
    { oldStart, newStart, lines: hunkLines },
  ] of hunks.entries()) {
    addGap(gap, oldStart, newStart);
    oldLine = oldStart;
    newLine = newStart;
    const firstRow = lines.length;
    for (const line of hunkLines) {
      const text = line.slice(1).replace(/\r$/, "");
      switch (line[0]) {
        case "+":
          lines.push({ text, newLine: newLine++, className: ADDED_LINE });
          break;
        case "-":
          lines.push({
            text,
            oldLine: oldLine++,
            className: REMOVED_LINE,
          });
          break;
        case "\\":
          lines.push({
            text: text.trimStart(),
            className: "cm-gitPatchAnnotation",
          });
          break;
        default:
          lines.push({ text, oldLine: oldLine++, newLine: newLine++ });
      }
    }

    for (let index = firstRow; index + 1 < lines.length; index++) {
      const [before, after] = [lines[index], lines[index + 1]];
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      if (
        before.className !== REMOVED_LINE ||
        after.className !== ADDED_LINE ||
        lines[index - 1]?.className === before.className ||
        lines[index + 2]?.className === after.className ||
        before.text.length + after.text.length > 512
      )
        continue;
      const changes = diff(before.text, after.text, {
        scanLimit: 500,
        timeout: Math.min(5, remaining),
      });
      before.marks = changes.map(({ fromA, toA }) => ({
        from: fromA,
        to: toA,
      }));
      after.marks = changes.map(({ fromB, toB }) => ({ from: fromB, to: toB }));
    }
  }
  addGap(hunks.length, original.length + 1, modified.length + 1);

  function patchGutter(side: "oldLine" | "newLine") {
    const maxNumber = lines.reduce(
      (max, line) => Math.max(max, line[side] ?? 0),
      0,
    );
    return gutter({
      class: `cm-lineNumbers cm-gitPatch-${side}`,
      initialSpacer: () => new PatchLineNumber(maxNumber),
      lineMarker: (view, line) => {
        const number =
          lines[view.state.doc.lineAt(line.from).number - 1]?.[side];
        return number === undefined ? null : new PatchLineNumber(number);
      },
    });
  }

  return {
    text: lines.map((line) => line.text).join("\n"),
    extensions: [
      externalChanges,
      EditorState.lineSeparator.of("\n"),
      patchGutter("oldLine"),
      patchGutter("newLine"),
      UNIFIED_DIFF_THEME,
      EditorView.decorations.compute(["doc"], (state) => {
        const decorations: Range<Decoration>[] = [];
        const lineCount = Math.min(state.doc.lines, lines.length);
        for (let number = 1; number <= lineCount; number++) {
          const { className, gap, marks } = lines[number - 1];
          const { from, to, length } = state.doc.line(number);
          if (gap !== undefined && length === 1) {
            decorations.push(
              Decoration.replace({
                widget: new ExpandContextWidget(gap, expandLabel, expand),
              }).range(from, to),
            );
          }
          if (className) {
            decorations.push(Decoration.line({ class: className }).range(from));
          }
          if (className === REMOVED_LINE || className === ADDED_LINE) {
            const mark = Decoration.mark({
              class:
                className === REMOVED_LINE
                  ? "cm-deletedText"
                  : "cm-changedText",
            });
            for (const span of marks ?? [{ from: 0, to: length }]) {
              if (span.from < span.to && span.to <= length)
                decorations.push(mark.range(from + span.from, from + span.to));
            }
          }
        }
        return Decoration.set(decorations, true);
      }),
    ],
  };
}
