/** 自选展示派生规则：稳定排序、缺失值置后以及多选期间的行位置冻结。 */
import type {
  WatchlistItem,
  WatchlistQuote,
} from "@/modules/alpha/watchlist/api";

export type WatchlistSort = {
  column: "change" | "date";
  direction: "asc" | "desc";
} | null;
/** 隐藏列时清除各分组对此列的临时排序，避免切组后出现不可见的排序条件。 */
export function clearWatchlistColumnSort(
  sorts: Record<string, WatchlistSort>,
  column: NonNullable<WatchlistSort>["column"],
) {
  return Object.fromEntries(
    Object.entries(sorts).map(([group, sort]) => [
      group,
      sort?.column === column ? null : sort,
    ]),
  );
}

export function orderWatchlist(
  items: WatchlistItem[],
  quotes: Map<string, WatchlistQuote>,
  sort: WatchlistSort,
  frozen: string[] | null = null,
) {
  const rows = [...items].sort(
    (a, b) => a.position - b.position || a.vt_symbol.localeCompare(b.vt_symbol),
  );
  if (frozen) {
    const ranks = new Map(frozen.map((symbol, index) => [symbol, index]));
    return rows.sort(
      (a, b) =>
        (ranks.get(a.vt_symbol) ?? frozen.length) -
        (ranks.get(b.vt_symbol) ?? frozen.length),
    );
  }
  if (!sort)
    return rows.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (a.pinned ? a.pin_position - b.pin_position : 0),
    );
  return rows.sort((a, b) => {
    const left = quotes.get(a.vt_symbol)?.[sort.column] ?? null;
    const right = quotes.get(b.vt_symbol)?.[sort.column] ?? null;
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    const result = left < right ? -1 : left > right ? 1 : 0;
    return sort.direction === "asc" ? result : -result;
  });
}

export function toggleWatchlistSelection(
  selected: Set<string>,
  rows: WatchlistItem[],
  symbol: string,
  anchor: string | null,
  range: boolean,
) {
  const next = new Set(selected);
  const checked = !next.has(symbol);
  const start = rows.findIndex((row) => row.vt_symbol === anchor);
  const end = rows.findIndex((row) => row.vt_symbol === symbol);
  const symbols =
    range && start >= 0 && end >= 0
      ? rows
          .slice(Math.min(start, end), Math.max(start, end) + 1)
          .map((row) => row.vt_symbol)
      : [symbol];
  for (const key of symbols) {
    if (checked) next.add(key);
    else next.delete(key);
  }
  return next;
}
