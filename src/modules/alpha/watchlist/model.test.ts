/** 自选排序与勾选业务不变量，避免行情排序写入手工顺序。 */

import type {
  WatchlistItem,
  WatchlistQuote,
} from "@/modules/alpha/watchlist/api";
import {
  clearWatchlistColumnSort,
  orderWatchlist,
  toggleWatchlistSelection,
} from "@/modules/alpha/watchlist/model";
import { expect, it } from "vitest";

const items: WatchlistItem[] = ["A", "B", "C", "D"].map(
  (vt_symbol, position) => ({
    group_id: "all",
    vt_symbol,
    name: vt_symbol,
    position,
    pinned: vt_symbol === "C",
    pin_position: 0,
    price_tick: 0.01,
  }),
);
const quotes = new Map<string, WatchlistQuote>(
  items.map((item, index) => [
    item.vt_symbol,
    {
      vt_symbol: item.vt_symbol,
      close: index,
      change: [2, null, -1, 2][index],
      date: null,
      closes: [],
      price_tick: 0.01,
      price_color_convention: "up-red",
      status: "daily",
    },
  ]),
);
const names = (rows: WatchlistItem[]) => rows.map((row) => row.vt_symbol);

it("全部成员参与稳定排序，缺失值始终末尾，取消后恢复置顶及手动顺序", () => {
  const before = structuredClone(items);
  expect(
    names(
      orderWatchlist(items, quotes, { column: "change", direction: "desc" }),
    ),
  ).toEqual(["A", "D", "C", "B"]);
  expect(
    names(
      orderWatchlist(items, quotes, { column: "change", direction: "asc" }),
    ),
  ).toEqual(["C", "A", "D", "B"]);
  expect(names(orderWatchlist(items, quotes, null))).toEqual([
    "C",
    "A",
    "B",
    "D",
  ]);
  expect(items).toEqual(before);
});

it("多选冻结当前顺序，行情变化不改变勾选位置，成员移除不复活旧行", () => {
  const frozen = ["A", "D", "C", "B"];
  expect(
    names(
      orderWatchlist(
        items,
        quotes,
        { column: "change", direction: "asc" },
        frozen,
      ),
    ),
  ).toEqual(frozen);
  expect(
    names(
      orderWatchlist(
        items.filter((row) => row.vt_symbol !== "D"),
        quotes,
        null,
        frozen,
      ),
    ),
  ).toEqual(["A", "C", "B"]);
  const selected = toggleWatchlistSelection(
    new Set(["A"]),
    items,
    "C",
    "A",
    true,
  );
  expect([...selected]).toEqual(["A", "B", "C"]);
  expect([
    ...toggleWatchlistSelection(selected, items, "A", "C", true),
  ]).toEqual([]);
});

it("隐藏行情日期列会清理所有分组的日期排序，但保留涨幅排序", () => {
  const change = { column: "change", direction: "desc" } as const;
  expect(
    clearWatchlistColumnSort(
      {
        all: { column: "date", direction: "asc" },
        group1: { column: "date", direction: "desc" },
        group2: change,
      },
      "date",
    ),
  ).toEqual({ all: null, group1: null, group2: change });
});
