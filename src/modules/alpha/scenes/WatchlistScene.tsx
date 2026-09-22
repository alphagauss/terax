/** 自选业务场景，复用证券查询，增删通过 Python API 精确提交。 */
import { Button } from "@/components/controls/button";
import { Input } from "@/components/controls/input";
import {
  getAlphaSecurities,
  getAlphaWatchlist,
  setAlphaWatchlistSymbol,
} from "@/modules/alpha/api";
import { alphaQueryKeys } from "@/modules/alpha/query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

const watchlistKey = ["alpha", "watchlist"] as const;
const SEARCH_PAGE_SIZE = 30;

/** 搜索结果与自选使用同一选中回调，不直接修改任一布局的主标的。 */
export function WatchlistScene({
  visible,
  symbol,
  onSelect,
}: {
  visible: boolean;
  symbol: string;
  onSelect: (symbol: string) => void;
}) {
  const { t } = useTranslation("alpha");
  const client = useQueryClient();
  const [draft, setDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [offset, setOffset] = useState(0);
  const list = useQuery({
    queryKey: watchlistKey,
    queryFn: getAlphaWatchlist,
    enabled: visible,
    staleTime: 0,
    refetchInterval: visible ? 5000 : false,
  });
  const search = useQuery({
    queryKey: [
      ...alphaQueryKeys.securities,
      "watchlist-search",
      keyword,
      offset,
    ],
    queryFn: () =>
      getAlphaSecurities({ q: keyword, limit: SEARCH_PAGE_SIZE, offset }),
    enabled: visible && Boolean(keyword),
  });
  const change = useMutation({
    mutationFn: ({ symbol, included }: { symbol: string; included: boolean }) =>
      setAlphaWatchlistSymbol(symbol, included),
    onSuccess: () => client.invalidateQueries({ queryKey: watchlistKey }),
  });
  const rows = (keyword ? search.data?.items : list.data) ?? [];
  const includedSymbols = new Set(list.data?.map((item) => item.vt_symbol));
  const error = list.error ?? (keyword ? search.error : null) ?? change.error;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        className="flex gap-1 border-b p-2"
        onSubmit={(event) => {
          event.preventDefault();
          setKeyword(draft.trim());
          setOffset(0);
        }}
      >
        <Input
          aria-label={t("desk.search")}
          placeholder={t("desk.search")}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (!event.target.value.trim()) setKeyword("");
          }}
          className="min-w-0"
        />
        <Button size="sm" variant="outline" type="submit">
          {t("desk.find")}
        </Button>
      </form>
      {keyword && (
        <Button
          variant="ghost"
          onClick={() => {
            setKeyword("");
            setDraft("");
          }}
        >
          {t("desk.backToWatchlist")}
        </Button>
      )}
      {error && (
        <p role="alert" className="p-2 text-xs text-destructive">
          {String(error)}
        </p>
      )}
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
        {(keyword ? search.isFetching : list.isPending) && (
          <p role="status" className="p-3 text-xs text-muted-foreground">
            {t("common.loading")}
          </p>
        )}
        {rows.map((row) => {
          const included = includedSymbols.has(row.vt_symbol);
          return (
            <div
              key={row.vt_symbol}
              className="flex items-center gap-1 border-b border-border/40 p-1"
            >
              <Button
                variant={symbol === row.vt_symbol ? "secondary" : "ghost"}
                className="h-auto min-w-0 flex-1 flex-col items-start gap-0 py-2"
                aria-pressed={symbol === row.vt_symbol}
                onClick={() => onSelect(row.vt_symbol)}
              >
                <span className="w-full truncate text-left">{row.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {row.vt_symbol}
                </span>
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={change.isPending || !list.data}
                aria-label={t(
                  included ? "desk.removeSymbol" : "desk.addSymbol",
                  { symbol: row.vt_symbol },
                )}
                onClick={() =>
                  change.mutate({ symbol: row.vt_symbol, included: !included })
                }
              >
                {t(included ? "desk.remove" : "desk.add")}
              </Button>
            </div>
          );
        })}
        {rows.length === 0 &&
          !(keyword ? search.isPending : list.isPending) &&
          !error && (
            <p className="p-3 text-xs text-muted-foreground">
              {t(keyword ? "desk.noResults" : "desk.emptyWatchlist")}
            </p>
          )}
      </div>
      {keyword && (
        <div className="flex shrink-0 items-center justify-between gap-1 border-t p-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={offset === 0 || search.isFetching}
            onClick={() => setOffset(Math.max(0, offset - SEARCH_PAGE_SIZE))}
          >
            {t("desk.previous")}
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {t("desk.resultCount", { count: search.data?.total ?? 0 })}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={
              search.isFetching ||
              offset + SEARCH_PAGE_SIZE >= (search.data?.total ?? 0)
            }
            onClick={() => setOffset(offset + SEARCH_PAGE_SIZE)}
          >
            {t("desk.next")}
          </Button>
        </div>
      )}
    </div>
  );
}
