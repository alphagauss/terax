import { type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  gutter,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

// 1-based new-file line numbers, grouped by change kind. `deleted` marks lines
// that have a deletion immediately above/at them (shown as a boundary bar).
export type GitChanges = {
  added: Set<number>;
  modified: Set<number>;
  deleted: Set<number>;
};

export const emptyGitChanges = (): GitChanges => ({
  added: new Set(),
  modified: new Set(),
  deleted: new Set(),
});

/**
 * Parse a `git diff` unified patch into per-line change kinds against the NEW
 * (worktree) file, so a gutter can mark added / modified / deleted lines.
 * Note: diff is worktree-vs-HEAD (recomputed on save), so staged and unstaged
 * edits share one baseline.
 */
export function parseUnifiedDiff(diffText: string): GitChanges {
  const res = emptyGitChanges();
  if (!diffText) return res;

  let newLine = 0;
  let pendingDel = 0; // deletions seen since the last addition/context line
  for (const raw of diffText.split("\n")) {
    if (raw === "") continue;
    if (raw.startsWith("@@")) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) newLine = Number.parseInt(m[1], 10);
      pendingDel = 0;
      continue;
    }
    // File headers / metadata — never part of a hunk body.
    if (
      raw.startsWith("+++ ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("rename ") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("\\")
    ) {
      continue;
    }

    const c = raw[0];
    if (c === "+") {
      if (pendingDel > 0) {
        res.modified.add(newLine);
        pendingDel--;
      } else {
        res.added.add(newLine);
      }
      newLine++;
    } else if (c === "-") {
      pendingDel++;
    } else {
      // context line: flush any unmatched deletions as a boundary marker here
      if (pendingDel > 0) {
        res.deleted.add(newLine);
        pendingDel = 0;
      }
      newLine++;
    }
  }
  if (pendingDel > 0) res.deleted.add(Math.max(1, newLine - 1));
  return res;
}

export const setGitChanges = StateEffect.define<GitChanges>();

const gitChangesField = StateField.define<GitChanges>({
  create: emptyGitChanges,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGitChanges)) return e.value;
    return value;
  },
});

class ChangeMarker extends GutterMarker {
  constructor(kind: "added" | "modified" | "deleted") {
    super();
    this.elementClass = `cm-change-${kind}`;
  }
}

const addedMarker = new ChangeMarker("added");
const modifiedMarker = new ChangeMarker("modified");
const deletedMarker = new ChangeMarker("deleted");

type ChangeKind = "added" | "modified" | "deleted";
type ChangeRange = { kind: ChangeKind; from: number; to: number };

function changeRanges(changes: GitChanges): ChangeRange[] {
  const kinds = new Map<number, ChangeKind>();
  for (const line of changes.deleted) kinds.set(line, "deleted");
  for (const line of changes.added) kinds.set(line, "added");
  for (const line of changes.modified) kinds.set(line, "modified");

  const ranges: ChangeRange[] = [];
  for (const line of [...kinds.keys()].sort((a, b) => a - b)) {
    const kind = kinds.get(line);
    const previous = ranges[ranges.length - 1];
    if (kind && previous?.kind === kind && previous.to + 1 === line) {
      previous.to = line;
    } else if (kind) {
      ranges.push({ kind, from: line, to: line });
    }
  }
  return ranges;
}

function renderOverview(
  view: EditorView,
  rail: HTMLDivElement,
  changes: GitChanges,
) {
  const ranges = changeRanges(changes);
  rail.replaceChildren();
  rail.hidden = ranges.length === 0;
  if (ranges.length === 0) return;

  const contentHeight = Math.max(view.contentHeight, 1);
  for (const range of ranges) {
    const firstLine = view.state.doc.line(
      Math.max(1, Math.min(range.from, view.state.doc.lines)),
    );
    const lastLine = view.state.doc.line(
      Math.max(1, Math.min(range.to, view.state.doc.lines)),
    );
    const firstBlock = view.lineBlockAt(firstLine.from);
    const lastBlock = view.lineBlockAt(lastLine.to);
    const top = (firstBlock.top / contentHeight) * 100;
    const bottom = ((lastBlock.top + lastBlock.height) / contentHeight) * 100;

    const marker = document.createElement("span");
    marker.className = `cm-changeOverview-${range.kind}`;
    marker.style.top = `${top}%`;
    marker.style.height = `${Math.max(0, bottom - top)}%`;
    rail.append(marker);
  }
}

class ChangeOverview {
  private readonly rail: HTMLDivElement;

  constructor(private readonly view: EditorView) {
    this.rail = document.createElement("div");
    this.rail.className = "cm-changeOverview";
    this.rail.setAttribute("aria-hidden", "true");
    view.dom.append(this.rail);
    renderOverview(view, this.rail, view.state.field(gitChangesField));
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.geometryChanged ||
      update.state.field(gitChangesField) !==
        update.startState.field(gitChangesField)
    ) {
      renderOverview(this.view, this.rail, update.state.field(gitChangesField));
    }
  }

  destroy() {
    this.rail.remove();
  }
}

const changeGutter = gutter({
  class: "cm-changeGutter",
  lineMarker(view, line) {
    const changes = view.state.field(gitChangesField, false);
    if (!changes) return null;
    const lineNo = view.state.doc.lineAt(line.from).number;
    if (changes.modified.has(lineNo)) return modifiedMarker;
    if (changes.added.has(lineNo)) return addedMarker;
    if (changes.deleted.has(lineNo)) return deletedMarker;
    return null;
  },
  lineMarkerChange: (update) =>
    update.state.field(gitChangesField) !==
    update.startState.field(gitChangesField),
});

const changeGutterTheme = EditorView.baseTheme({
  ".cm-changeGutter": { width: "3px", padding: "0" },
  ".cm-changeGutter .cm-gutterElement": { padding: "0" },
  ".cm-change-added": {
    backgroundColor: "var(--terminal-ansi-green)",
  },
  ".cm-change-modified": {
    backgroundColor: "var(--terminal-ansi-blue)",
  },
  ".cm-change-deleted": {
    boxShadow: "inset 0 -2px 0 0 var(--terminal-ansi-red)",
  },
  ".cm-changeOverview": {
    position: "absolute",
    top: "2px",
    right: "1px",
    bottom: "2px",
    width: "6px",
    pointerEvents: "none",
    zIndex: "1",
  },
  ".cm-changeOverview-added, .cm-changeOverview-modified, .cm-changeOverview-deleted":
    {
      position: "absolute",
      left: "1px",
      right: "1px",
      minHeight: "2px",
      borderRadius: "1px",
    },
  ".cm-changeOverview-added": {
    backgroundColor: "var(--terminal-ansi-green)",
  },
  ".cm-changeOverview-modified": {
    backgroundColor: "var(--terminal-ansi-blue)",
  },
  ".cm-changeOverview-deleted": {
    backgroundColor: "var(--terminal-ansi-red)",
  },
});

export const gitChangeGutter: Extension = [
  gitChangesField,
  changeGutter,
  changeGutterTheme,
  ViewPlugin.fromClass(ChangeOverview),
];
