import {
  FIND_PRESENCE_MS,
  type FindOptions,
  FindReplaceWidget,
  type FindResult,
  type FindWidgetHandle,
} from "@/modules/find";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  type SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorSelection, type Text } from "@codemirror/state";
import type { EditorView, Panel, ViewUpdate } from "@codemirror/view";
import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  collectFindMatches,
  createEditorFindQuery,
  type FindMatches,
  type FindRange,
  findMatchPosition,
  mapFindRanges,
} from "./editorFindModel";
import { replacementForMatch } from "./replacement";

const MATCH_LIMIT = 999;
const LARGE_DOCUMENT = 1_000_000;
const editorFindPanels = new WeakMap<EditorView, EditorFindPanel>();

type CursorMatch = FindRange & {
  precise?: boolean;
  match?: RegExpExecArray;
};

type MatchCache = FindMatches & {
  doc: Text;
  query: SearchQuery;
};

function queryOptions(query: SearchQuery): FindOptions {
  return {
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    regexp: query.regexp,
  };
}

function queryValue(query: SearchQuery) {
  return {
    search: query.search,
    replace: query.replace,
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    regexp: query.regexp,
    literal: query.literal,
  };
}

function selectionRanges(view: EditorView): FindRange[] {
  return view.state.selection.ranges
    .filter((range) => !range.empty)
    .map(({ from, to }) => ({ from, to }));
}

function matchAtSelection(
  view: EditorView,
  query: SearchQuery,
): CursorMatch | null {
  const { from, to } = view.state.selection.main;
  const cursor = query.getCursor(view.state, from, to);
  const next = cursor.next();
  if (next.done) return null;
  const match = next.value as CursorMatch;
  return match.from === from && match.to === to ? match : null;
}

export function createEditorFindPanel(view: EditorView): Panel {
  const panel = new EditorFindPanel(view);
  editorFindPanels.set(view, panel);
  return panel;
}

function focusEditorFindPanel(view: EditorView): void {
  const input = view.dom.querySelector<HTMLInputElement>(
    '.terax-find-panel-host [main-field="true"]',
  );
  if (!input) return;
  input.focus({ preventScroll: true });
  input.select();
}

export function openEditorFindPanel(view: EditorView): boolean {
  const panel = editorFindPanels.get(view);
  if (panel) {
    panel.reopen();
    return true;
  }
  openSearchPanel(view);
  queueMicrotask(() => focusEditorFindPanel(view));
  return true;
}

class EditorFindPanel implements Panel {
  readonly dom = document.createElement("div");
  readonly top = true;
  readonly pos = 80;

  private readonly root: Root;
  private readonly widgetRef = createRef<FindWidgetHandle>();
  private query: SearchQuery;
  private scope: FindRange[] | null = null;
  private scopeCandidate: FindRange[];
  private matches: MatchCache | null = null;
  private matchTimer: number | null = null;
  private closeTimer: number | null = null;
  private replaceOpen = false;
  private preserveCase = false;
  private closing = false;
  private mounted = false;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.dom.className = "terax-find-panel-host";
    this.query = getSearchQuery(view.state);
    this.scopeCandidate = selectionRanges(view);
    this.root = createRoot(this.dom);
  }

  mount(): void {
    this.mounted = true;
    this.render();
    this.scheduleMatches();
  }

  update(update: ViewUpdate): void {
    let queryChanged = false;
    let externalQuery: SearchQuery | null = null;

    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (!effect.is(setSearchQuery)) continue;
        queryChanged = true;
        if (effect.value !== this.query) externalQuery = effect.value;
        this.query = effect.value;
      }
    }

    if (update.docChanged) {
      this.scopeCandidate = mapFindRanges(this.scopeCandidate, update.changes);
      if (this.scope) {
        this.scope = mapFindRanges(this.scope, update.changes);
        if (this.scope.length === 0) this.scope = null;
        externalQuery = this.query;
      }
    }

    if (externalQuery && this.scope) {
      const scoped = createEditorFindQuery(
        queryValue(externalQuery),
        this.scope,
      );
      this.query = scoped;
      this.dispatchQueryLater(scoped);
      queryChanged = true;
    } else if (update.docChanged && externalQuery && !this.scope) {
      const unscoped = createEditorFindQuery(queryValue(externalQuery), null);
      this.query = unscoped;
      this.dispatchQueryLater(unscoped);
      queryChanged = true;
    }

    if (queryChanged || update.docChanged) this.scheduleMatches();
    else if (update.selectionSet) {
      const searchNavigation = update.transactions.some((transaction) =>
        transaction.isUserEvent("select.search"),
      );
      if (!this.scope && !searchNavigation) {
        this.scopeCandidate = selectionRanges(this.view);
      }
      this.render();
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.matchTimer !== null) window.clearTimeout(this.matchTimer);
    if (this.closeTimer !== null) window.clearTimeout(this.closeTimer);
    if (editorFindPanels.get(this.view) === this) {
      editorFindPanels.delete(this.view);
    }
    this.root.unmount();
  }

  reopen(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.closing) {
      this.closing = false;
      this.render();
    }
    queueMicrotask(() => this.widgetRef.current?.focus(true));
  }

  private render(): void {
    if (!this.mounted || this.destroyed) return;
    const result = this.findResult();
    const element = (
      <FindReplaceWidget
        ref={this.widgetRef}
        autoFocus
        state={this.closing ? "closed" : "open"}
        query={this.query.search}
        invalid={this.query.search.length > 0 && !this.query.valid}
        options={queryOptions(this.query)}
        result={result}
        onQueryChange={(search) => this.updateQuery({ search })}
        onOptionsChange={(options) => this.updateQuery(options)}
        onPrevious={() => findPrevious(this.view)}
        onNext={() => findNext(this.view)}
        onClose={() => this.close()}
        selection={{
          active: this.scope !== null,
          available: this.scope !== null || this.scopeCandidate.length > 0,
          onToggle: () => this.toggleScope(),
        }}
        replace={{
          value: this.query.replace,
          open: this.replaceOpen,
          preserveCase: this.preserveCase,
          disabled: this.view.state.readOnly,
          onChange: (replaceValue) =>
            this.updateQuery({ replace: replaceValue }),
          onOpenChange: (open) => {
            this.replaceOpen = open;
            this.render();
          },
          onPreserveCaseChange: (enabled) => {
            this.preserveCase = enabled;
            this.render();
          },
          onReplace: () => this.replaceOne(),
          onReplaceAll: () => this.replaceEveryMatch(),
        }}
      />
    );

    this.root.render(element);
  }

  private findResult(): FindResult | undefined {
    const cache = this.matches;
    if (
      !cache ||
      cache.doc !== this.view.state.doc ||
      !cache.query.eq(this.query)
    ) {
      return undefined;
    }
    return {
      current: findMatchPosition(
        cache.ranges,
        this.view.state.selection.main,
        cache.limited,
      ),
      total: cache.ranges.length,
      limited: cache.limited,
    };
  }

  private scheduleMatches(): void {
    if (this.matchTimer !== null) window.clearTimeout(this.matchTimer);
    this.matches = null;
    this.render();
    if (!this.query.valid) return;

    const doc = this.view.state.doc;
    const query = this.query;
    const delay = doc.length >= LARGE_DOCUMENT ? 120 : 0;
    this.matchTimer = window.setTimeout(() => {
      this.matchTimer = null;
      if (
        this.destroyed ||
        this.view.state.doc !== doc ||
        !this.query.eq(query)
      ) {
        return;
      }
      this.matches = {
        doc,
        query,
        ...collectFindMatches(this.view.state, query, MATCH_LIMIT),
      };
      this.render();
    }, delay);
  }

  private updateQuery(
    patch: Partial<ReturnType<typeof queryValue> | FindOptions>,
  ): void {
    const next = createEditorFindQuery(
      { ...queryValue(this.query), ...patch },
      this.scope,
    );
    if (next.eq(this.query)) return;
    this.query = next;
    this.view.dispatch({ effects: setSearchQuery.of(next) });
  }

  private toggleScope(): void {
    this.scope = this.scope
      ? null
      : this.scopeCandidate.map((range) => ({ ...range }));
    if (this.scope?.length === 0) this.scope = null;
    const next = createEditorFindQuery(queryValue(this.query), this.scope);
    this.query = next;
    this.view.dispatch({ effects: setSearchQuery.of(next) });
    this.widgetRef.current?.focus(false);
  }

  private close(): void {
    if (this.closing) return;
    if (this.scope) {
      this.scope = null;
      const next = createEditorFindQuery(queryValue(this.query), null);
      this.query = next;
      this.view.dispatch({ effects: setSearchQuery.of(next) });
    }
    this.closing = true;
    this.render();
    this.view.focus();
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      closeSearchPanel(this.view);
    }, FIND_PRESENCE_MS);
  }

  private dispatchQueryLater(query: SearchQuery): void {
    queueMicrotask(() => {
      if (this.destroyed || getSearchQuery(this.view.state).eq(query)) return;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    });
  }

  private replaceOne(): void {
    if (this.view.state.readOnly || !this.query.valid) return;
    if (!this.preserveCase) {
      replaceNext(this.view);
      return;
    }

    const match = matchAtSelection(this.view, this.query);
    if (!match || match.precise === false) {
      findNext(this.view);
      return;
    }
    const source = this.view.state.sliceDoc(match.from, match.to);
    const insert = replacementForMatch({
      replacement: this.query.replace,
      source,
      regexpMatch: match.match,
      preserveCase: true,
    });
    this.view.dispatch({
      changes: { from: match.from, to: match.to, insert },
      selection: EditorSelection.cursor(match.from + insert.length),
      userEvent: "input.replace",
    });
    findNext(this.view);
  }

  private replaceEveryMatch(): void {
    if (this.view.state.readOnly || !this.query.valid) return;
    if (!this.preserveCase) {
      replaceAll(this.view);
      return;
    }

    const changes: { from: number; to: number; insert: string }[] = [];
    const cursor = this.query.getCursor(this.view.state);
    while (true) {
      const next = cursor.next();
      if (next.done) break;
      const match = next.value as CursorMatch;
      if (match.precise === false) continue;
      const source = this.view.state.sliceDoc(match.from, match.to);
      changes.push({
        from: match.from,
        to: match.to,
        insert: replacementForMatch({
          replacement: this.query.replace,
          source,
          regexpMatch: match.match,
          preserveCase: true,
        }),
      });
    }
    if (changes.length > 0) {
      this.view.dispatch({ changes, userEvent: "input.replace.all" });
    }
  }
}
