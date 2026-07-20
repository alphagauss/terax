import { SearchQuery } from "@codemirror/search";
import {
  type ChangeDesc,
  type ChangeSet,
  type EditorState,
  EditorSelection,
  type SelectionRange,
} from "@codemirror/state";

export type FindRange = {
  from: number;
  to: number;
};

export type EditorFindQueryValue = {
  search: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  literal: boolean;
};

export type FindMatches = {
  ranges: readonly FindRange[];
  limited: boolean;
};

export function createEditorFindQuery(
  value: EditorFindQueryValue,
  scope: readonly FindRange[] | null,
): SearchQuery {
  const ranges = scope?.map((range) => ({ ...range })) ?? null;
  return new SearchQuery({
    ...value,
    test: ranges
      ? (_match, _state, from, to) =>
          ranges.some((range) => from >= range.from && to <= range.to)
      : undefined,
  });
}

export function mapFindRanges(
  ranges: readonly FindRange[],
  changes: ChangeDesc,
): FindRange[] {
  return ranges
    .map((range) => ({
      from: changes.mapPos(range.from),
      to: changes.mapPos(range.to, 1),
    }))
    .filter((range) => range.to > range.from);
}

export function collectFindMatches(
  state: EditorState,
  query: SearchQuery,
  limit: number,
): FindMatches {
  if (!query.valid) return { ranges: [], limited: false };

  const cursor = query.getCursor(state);
  const ranges: FindRange[] = [];
  while (ranges.length < limit) {
    const next = cursor.next();
    if (next.done) return { ranges, limited: false };
    ranges.push(next.value);
  }
  return { ranges, limited: !cursor.next().done };
}

export function findMatchPosition(
  ranges: readonly FindRange[],
  selection: SelectionRange,
  limited = false,
): number {
  const selected = ranges.findIndex(
    (range) => range.from === selection.from && range.to === selection.to,
  );
  if (selected >= 0) return selected + 1;
  const next = ranges.findIndex((range) => range.from >= selection.from);
  if (next >= 0) return next + 1;
  return limited ? 0 : ranges.length > 0 ? 1 : 0;
}

function nextDistinctMatch(
  cursor: Iterator<FindRange>,
  current: FindRange,
): FindRange | null {
  let next = cursor.next();
  while (!next.done) {
    if (next.value.from !== current.from || next.value.to !== current.to) {
      return next.value;
    }
    next = cursor.next();
  }
  return null;
}

function findNextMatch(
  state: EditorState,
  query: SearchQuery,
  current: FindRange,
): FindRange | null {
  return (
    nextDistinctMatch(query.getCursor(state, current.to), current) ??
    nextDistinctMatch(query.getCursor(state, 0, current.from), current)
  );
}

export function replaceMatchAndSelectNext(
  state: EditorState,
  query: SearchQuery,
  match: FindRange,
  insert: string,
): { changes: ChangeSet; selection: EditorSelection } {
  const next = findNextMatch(state, query, match);
  const changes = state.changes({ ...match, insert });
  const selection = next
    ? EditorSelection.single(next.from, next.to).map(changes)
    : EditorSelection.single(match.from + insert.length);
  return { changes, selection };
}
