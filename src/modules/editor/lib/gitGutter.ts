/**
 * 本文件实现编辑器中的 Git Quick Diff 行号槽与滚动概览。
 * 编辑器键入时增量更新基线 chunks，Git diff 页面直接复用 MergeView 已计算的 chunks。
 */

import {
  buildQuickDiff,
  type QuickDiffRange,
  type QuickDiffSnapshot,
  rangesFromChunks,
  updateQuickDiff,
} from "@/modules/editor/lib/quickDiff";
import { getChunks, getOriginalDoc } from "@codemirror/merge";
import {
  type Extension,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  gutter,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

export const setQuickDiffBaseline = StateEffect.define<string | null>();

const quickDiffField = StateField.define<QuickDiffSnapshot | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setQuickDiffBaseline)) {
        if (effect.value === null) return null;
        return buildQuickDiff(
          Text.of(effect.value.split(/\r\n?|\n/)),
          transaction.newDoc,
        );
      }
    }
    return value && transaction.docChanged
      ? updateQuickDiff(value, transaction.newDoc, transaction.changes)
      : value;
  },
});

class ChangeMarker extends GutterMarker {
  constructor(private readonly kind: QuickDiffRange["kind"]) {
    super();
  }

  /** 将 Git 标记绘制到独立子层，避免与活动行 gutter 样式争用背景和阴影。 */
  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = `cm-changeMarker cm-change-${this.kind}`;
    return marker;
  }
}

const markers = {
  added: new ChangeMarker("added"),
  modified: new ChangeMarker("modified"),
  deleted: new ChangeMarker("deleted"),
};

/** 判断元素是否存在需要滚动条承载的纵向溢出。 */
export function hasVerticalScroll(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight;
}

/** 绘制 Git 变更概览，并在编辑器无需纵向滚动时隐藏整个 rail。 */
export function renderGitChangeOverview(
  view: EditorView,
  rail: HTMLDivElement,
  ranges: readonly QuickDiffRange[],
  scrollElement: HTMLElement = view.scrollDOM,
) {
  rail.replaceChildren();
  rail.hidden = ranges.length === 0 || !hasVerticalScroll(scrollElement);
  if (rail.hidden) return;

  const contentHeight = Math.max(view.contentHeight, 1);
  for (const range of ranges) {
    const firstLine = view.state.doc.line(
      Math.max(1, Math.min(range.fromLine, view.state.doc.lines)),
    );
    const lastLine = view.state.doc.line(
      Math.max(1, Math.min(range.toLine, view.state.doc.lines)),
    );
    const firstBlock = view.lineBlockAt(firstLine.from);
    const lastBlock = view.lineBlockAt(lastLine.to);
    const top = (firstBlock.top / contentHeight) * 100;
    const bottom = ((lastBlock.top + lastBlock.height) / contentHeight) * 100;
    const kinds =
      range.kind === "modified"
        ? (["deleted", "added"] as const)
        : ([range.kind] as const);
    for (const kind of kinds) {
      const marker = document.createElement("span");
      marker.className = `cm-changeOverview-${kind}`;
      marker.style.top = `${top}%`;
      marker.style.height = `${Math.max(0, bottom - top)}%`;
      rail.append(marker);
    }
  }
}

class ChangeOverview {
  private readonly rail: HTMLDivElement;

  constructor(private readonly view: EditorView) {
    this.rail = document.createElement("div");
    this.rail.className = "cm-changeOverview";
    this.rail.setAttribute("aria-hidden", "true");
    view.dom.append(this.rail);
    this.render();
  }

  update(update: ViewUpdate) {
    const currentField = update.state.field(quickDiffField, false);
    const previousField = update.startState.field(quickDiffField, false);
    const currentChunks = getChunks(update.state)?.chunks;
    const previousChunks = getChunks(update.startState)?.chunks;
    if (
      update.docChanged ||
      update.geometryChanged ||
      currentField !== previousField ||
      currentChunks !== previousChunks
    ) {
      this.render();
    }
  }

  destroy() {
    this.rail.remove();
  }

  private render() {
    const snapshot = this.view.state.field(quickDiffField, false);
    const merge = snapshot ? null : getChunks(this.view.state);
    const ranges = snapshot
      ? snapshot.ranges
      : merge?.side === null
        ? rangesFromChunks(
            getOriginalDoc(this.view.state),
            this.view.state.doc,
            merge.chunks,
          )
        : [];
    renderGitChangeOverview(this.view, this.rail, ranges);
  }
}

const changeGutter = gutter({
  class: "cm-changeGutter",
  lineMarker(view, line) {
    const lineNumber = view.state.doc.lineAt(line.from).number;
    const range = view.state
      .field(quickDiffField, false)
      ?.ranges.find(
        (candidate) =>
          lineNumber >= candidate.fromLine && lineNumber <= candidate.toLine,
      );
    return range ? markers[range.kind] : null;
  },
  lineMarkerChange: (update) =>
    update.state.field(quickDiffField) !==
    update.startState.field(quickDiffField),
});

const changeGutterTheme = EditorView.baseTheme({
  ".cm-changeGutter": { width: "3px", padding: "0" },
  ".cm-changeGutter .cm-gutterElement": {
    width: "3px",
    padding: "0",
    position: "relative",
  },
  ".cm-changeMarker": {
    display: "block",
    width: "100%",
    height: "100%",
  },
  ".cm-change-added": {
    backgroundColor: "var(--editor-git-added)",
  },
  ".cm-change-modified": {
    backgroundColor: "var(--editor-git-modified)",
  },
  ".cm-change-deleted": {
    boxShadow: "inset 0 -2px 0 0 var(--editor-git-deleted)",
  },
});

const changeOverviewPlugin = ViewPlugin.fromClass(ChangeOverview);

export const gitChangeOverview: Extension = changeOverviewPlugin;

export const gitChangeGutter: Extension = [
  quickDiffField,
  changeGutter,
  changeGutterTheme,
  changeOverviewPlugin,
];
