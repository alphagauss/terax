/** 自选表负责虚拟滚动、固定表头与拖动反馈，业务命令交给场景提交。 */
import { Button } from "@/components/controls/button";
import { WatchlistCancelButton } from "@/modules/alpha/watchlist/WatchlistCancelButton";
import type {
  WatchlistCommand,
  WatchlistItem,
  WatchlistQuote,
  WatchlistSnapshot,
} from "@/modules/alpha/watchlist/api";
import type { WatchlistSort } from "@/modules/alpha/watchlist/model";
import { useWatchlistDrag } from "@/modules/alpha/watchlist/useWatchlistDrag";
import { WatchlistRow } from "@/modules/alpha/watchlist/WatchlistRow";
import { useVirtualizer } from "@tanstack/react-virtual";
import "@/modules/alpha/watchlist/watchlist.css";
import { useTranslation } from "react-i18next";

/** 行情排序和多选期间禁用重排；拖动只提交相邻证券定位。 */
export function WatchlistTable({
  rows,
  quoteMap,
  groups,
  symbol,
  editing,
  selected,
  locked,
  sort,
  showDate,
  visible,
  pending,
  onSelect,
  onToggle,
  onCommand,
  onFreeze,
  onSort,
  onCancelSort,
}: {
  rows: WatchlistItem[];
  quoteMap: Map<string, WatchlistQuote>;
  groups: WatchlistSnapshot["groups"];
  symbol: string;
  editing: boolean;
  selected: Set<string>;
  locked: boolean;
  sort: WatchlistSort;
  showDate: boolean;
  visible: boolean;
  pending: boolean;
  onSelect: (symbol: string) => void;
  onToggle: (symbol: string, range: boolean) => void;
  onCommand: (command: WatchlistCommand) => void;
  onFreeze: (symbols: string[] | null) => void;
  onSort: (column: "change" | "date") => void;
  onCancelSort: () => void;
}) {
  const { t } = useTranslation("alpha");
  const drag = useWatchlistDrag({
    enabled: visible && !editing && !sort && !locked,
    rows,
    onFreeze,
    onCommand,
  });
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => drag.viewport.current,
    estimateSize: () => 52,
    overscan: 8,
    getItemKey: (index) => rows[index].vt_symbol,
    enabled: visible,
  });
  const arrow = (column: "change" | "date") =>
    sort?.column === column ? (sort.direction === "asc" ? " ↑" : " ↓") : "";
  return (
    <div
      ref={drag.viewport}
      className="app-scrollbar min-h-0 flex-1 overflow-auto"
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerCancel}
      onLostPointerCapture={drag.onLostPointerCapture}
      onClickCapture={drag.onClickCapture}
    >
      <div
        style={{
          minWidth: (showDate ? 334 : 240) + (editing ? 28 : 0),
          width: editing ? "calc(100% + 28px)" : "100%",
        }}
      >
        <div
          data-show-date={showDate}
          className="alpha-watchlist-columns sticky top-0 z-10 h-10 items-center bg-background pr-2 text-xs font-semibold text-foreground"
          style={{ paddingLeft: editing ? 36 : 8 }}
        >
          <div
            className={`sticky z-[1] min-w-0 flex-1 bg-background ${editing ? "left-9" : "left-2"}`}
          >
            {sort ? (
              <WatchlistCancelButton
                disabled={editing || locked}
                onClick={onCancelSort}
              >
                {t("watch.cancelSort")}
              </WatchlistCancelButton>
            ) : (
              t("watch.security")
            )}
          </div>
          <span className="min-w-0 truncate text-center">
            {t("watch.trend")}
          </span>
          <div className="w-[72px] shrink-0 text-right">
            <Button
              size="xs"
              variant="ghost"
              disabled={editing || locked}
              className="font-semibold"
              onClick={() => onSort("change")}
            >
              {t("watch.change")}
              {arrow("change")}
            </Button>
            <span className="block text-[10px]">{t("watch.close")}</span>
          </div>
          {showDate && (
            <Button
              size="xs"
              className="w-[86px] shrink-0"
              variant="ghost"
              disabled={editing || locked}
              onClick={() => onSort("date")}
            >
              {t("watch.dataDate")}
              {arrow("date")}
            </Button>
          )}
        </div>
        {pending && (
          <p role="status" className="p-3 text-xs text-muted-foreground">
            {t("common.loading")}
          </p>
        )}
        {!pending && !rows.length && (
          <p className="p-3 text-xs text-muted-foreground">
            {t("desk.emptyWatchlist")}
          </p>
        )}
        <div className="relative" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((entry) => {
            const row = rows[entry.index];
            return (
              <div
                key={entry.key}
                className="absolute left-0 top-0 w-full"
                style={{
                  height: entry.size,
                  transform: `translateY(${entry.start}px)`,
                }}
              >
                <WatchlistRow
                  item={row}
                  quote={quoteMap.get(row.vt_symbol)}
                  groups={groups}
                  active={symbol === row.vt_symbol}
                  editing={editing}
                  checked={selected.has(row.vt_symbol)}
                  locked={locked}
                  sorted={Boolean(sort)}
                  showDate={showDate}
                  onSelect={() => onSelect(row.vt_symbol)}
                  onToggle={(range) => onToggle(row.vt_symbol, range)}
                  onCommand={onCommand}
                  onMenu={(open) => {
                    if (!editing)
                      onFreeze(
                        open ? rows.map((item) => item.vt_symbol) : null,
                      );
                  }}
                  onPointerDown={(event) => drag.start(event, row)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
