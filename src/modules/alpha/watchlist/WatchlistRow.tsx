/** 自选行组合轻量日线图与领域菜单，不持有查询或业务写入生命周期。 */
import { Hint } from "@/components/controls/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/menu/context-menu";
import { Checkbox } from "@/components/ui/checkbox";
import {
  marketDirectionColors,
  pricePrecisionFromMinMove,
} from "@/modules/alpha/market/metadata";
import type {
  WatchlistCommand,
  WatchlistItem,
  WatchlistQuote,
  WatchlistSnapshot,
} from "@/modules/alpha/watchlist/api";
import type { PointerEvent } from "react";
import { useTranslation } from "react-i18next";

/** 二十点趋势仅使用 SVG 路径；缺口不补值，也不建立图表引擎实例。 */
function CloseLine({ values }: { values: (number | null)[] }) {
  const valid = values.filter((value): value is number => value !== null);
  if (!valid.length) return <span className="text-muted-foreground">--</span>;
  const low = Math.min(...valid);
  const range = Math.max(...valid) - low;
  let connected = false;
  const path = values
    .map((value, index) => {
      if (value === null) {
        connected = false;
        return "";
      }
      const x =
        values.length === 1 ? 50 : 2 + (index * 96) / (values.length - 1);
      const y = range === 0 ? 16 : 29 - ((value - low) / range) * 26;
      const segment = `${connected ? "L" : "M"}${x},${y}`;
      connected = true;
      return segment;
    })
    .join(" ");
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 32"
      className="h-8 w-full text-muted-foreground"
      preserveAspectRatio="none"
    >
      {valid.length === 1 ? (
        <circle cx="50" cy="16" r="1.5" fill="currentColor" />
      ) : (
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

export function WatchlistRow({
  item,
  quote,
  groups,
  active,
  editing,
  checked,
  locked,
  sorted,
  showDate,
  onSelect,
  onToggle,
  onCommand,
  onMenu,
  onPointerDown,
}: {
  item: WatchlistItem;
  quote?: WatchlistQuote;
  groups: WatchlistSnapshot["groups"];
  active: boolean;
  editing: boolean;
  checked: boolean;
  locked: boolean;
  sorted: boolean;
  showDate: boolean;
  onSelect: () => void;
  onToggle: (range: boolean) => void;
  onCommand: (command: WatchlistCommand) => void;
  onMenu: (open: boolean) => void;
  onPointerDown: (event: PointerEvent) => void;
}) {
  const { t, i18n } = useTranslation("alpha");
  const group_id = item.group_id;
  const symbols: [string] = [item.vt_symbol];
  const targets = groups.filter((group) => group.id !== group_id);
  const colors = marketDirectionColors(
    "var(--success)",
    "var(--destructive)",
    quote?.price_color_convention ?? "up-red",
  );
  const change = quote?.change;
  const color =
    change == null || change === 0
      ? undefined
      : change > 0
        ? colors.up
        : colors.down;
  const precision = pricePrecisionFromMinMove(
    quote?.price_tick ?? item.price_tick,
  );
  const price =
    quote?.close == null
      ? "--"
      : new Intl.NumberFormat(
          i18n.language,
          precision === null
            ? { maximumFractionDigits: 8 }
            : {
                minimumFractionDigits: precision,
                maximumFractionDigits: precision,
              },
        ).format(quote.close);
  const quoteHint = [
    t("watch.dailyHint", { date: quote?.date ?? "--" }),
    quote?.status === "error"
      ? t("watch.quoteError")
      : quote?.status === "missing"
        ? t("watch.noQuote")
        : "",
  ]
    .filter(Boolean)
    .join(" ");
  const removeLabel = t(
    group_id === "all" ? "watch.removeAll" : "watch.removeGroup",
  );
  return (
    <ContextMenu onOpenChange={onMenu}>
      <ContextMenuTrigger asChild disabled={editing || locked}>
        {/* biome-ignore lint/a11y/useSemanticElements: 证券交互行组合选择按钮与复选框，不是表单字段组。 */}
        <div
          role="group"
          aria-label={item.name}
          className="alpha-watchlist-row relative flex h-[52px] select-none items-center border-b border-border/40"
          data-selected={editing ? checked : active}
          data-watchlist-symbol={item.vt_symbol}
          onPointerDown={onPointerDown}
        >
          {editing && (
            <div
              data-watchlist-frozen
              className="sticky left-0 z-[2] flex h-full w-7 shrink-0 items-center justify-center"
            >
              <Checkbox
                checked={checked}
                disabled={locked}
                aria-label={t("watch.selectSymbol", { name: item.name })}
                onClick={(event) => onToggle(event.shiftKey)}
              />
            </div>
          )}
          <button
            type="button"
            disabled={locked}
            aria-pressed={editing ? checked : active}
            onClick={(event) =>
              editing ? onToggle(event.shiftKey) : onSelect()
            }
            data-show-date={showDate}
            className={`alpha-watchlist-columns h-full min-w-0 flex-1 items-center px-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${!editing && !sorted && !locked ? "cursor-grab" : ""}`}
          >
            <span
              data-watchlist-frozen
              className={`sticky z-[1] min-w-0 py-2 ${editing ? "left-9" : "left-2"}`}
            >
              <Hint content={`${item.name} (${item.vt_symbol})`}>
                <span className="flex items-center gap-1 text-xs">
                  {item.pinned && (
                    <svg
                      role="img"
                      aria-label={t("watch.pinned")}
                      className="size-3 shrink-0 text-muted-foreground"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                    >
                      <title>{t("watch.pinned")}</title>
                      <path d="M5 2h6l-1 4 3 3H3l3-3-1-4ZM8 9v5" />
                    </svg>
                  )}
                  <span className="truncate">{item.name}</span>
                </span>
              </Hint>
              <span className="block truncate font-mono text-[10px] text-muted-foreground">
                {item.vt_symbol}
              </span>
            </span>
            <span className="flex min-w-0 justify-center">
              <CloseLine values={quote?.closes ?? []} />
            </span>
            <Hint content={quoteHint}>
              <span className="w-[72px] shrink-0 text-right tabular-nums">
                <span className="block text-xs" style={{ color }}>
                  {change == null
                    ? "--"
                    : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {price}
                </span>
              </span>
            </Hint>
            {showDate && (
              <span className="w-[86px] shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {quote?.date ?? "--"}
              </span>
            )}
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() =>
            onCommand({
              action: "pin",
              group_id,
              symbols,
              pinned: !item.pinned,
            })
          }
        >
          {t(item.pinned ? "watch.unpin" : "watch.pin")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={sorted}
          onSelect={() =>
            onCommand({ action: "reorder", group_id, symbols, edge: "first" })
          }
        >
          {t("watch.first")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={sorted}
          onSelect={() =>
            onCommand({ action: "reorder", group_id, symbols, edge: "last" })
          }
        >
          {t("watch.last")}
        </ContextMenuItem>
        {sorted && (
          <p className="max-w-52 px-2 py-1 text-xs text-muted-foreground">
            {t("watch.cancelToReorder")}
          </p>
        )}
        <ContextMenuSeparator />
        {(["copy", "move"] as const)
          .filter((action) => action !== "move" || group_id !== "all")
          .map((action) => (
            <ContextMenuSub key={action}>
              <ContextMenuSubTrigger disabled={!targets.length}>
                {t(
                  action === "copy" && group_id === "all"
                    ? "watch.addToGroup"
                    : `watch.${action}`,
                )}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {targets.map((group) => (
                  <ContextMenuItem
                    key={group.id}
                    onSelect={() =>
                      onCommand({
                        action,
                        group_id,
                        symbols,
                        target_group_id: group.id,
                      })
                    }
                  >
                    {group.name}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          ))}
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onSelect={() => onCommand({ action: "remove", group_id, symbols })}
        >
          {removeLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
