/** 自选场景连接权威分组与批量行情；排序、多选和搜索仅属于当前页面会话。 */
import { Button } from "@/components/controls/button";
import { Input } from "@/components/controls/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import { Hint } from "@/components/controls/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { getAlphaSecurities } from "@/modules/alpha/api";
import {
  changeWatchlist,
  getWatchlist,
  getWatchlistQuotes,
  type WatchlistCommand,
} from "@/modules/alpha/watchlist/api";
import {
  clearWatchlistColumnSort,
  orderWatchlist,
  toggleWatchlistSelection,
  type WatchlistSort,
} from "@/modules/alpha/watchlist/model";
import { WatchlistCancelButton } from "@/modules/alpha/watchlist/WatchlistCancelButton";
import { WatchlistTable } from "@/modules/alpha/watchlist/WatchlistTable";
import { WorkbenchPageWindow } from "@/modules/workbench/WorkbenchPageOverlays";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const listKey = ["alpha", "watchlist"] as const;
const quotesKey = ["alpha", "watchlist-quotes"] as const;
const PAGE_SIZE = 30;

/** 隐藏时暂停展示查询，已提交业务命令不随组件可见性取消。 */
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
  const [requestedGroup, setGroup] = useState("all");
  const [sorts, setSorts] = useState<Record<string, WatchlistSort>>({});
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const selectionAnchor = useRef<string | null>(null);
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const [showDate, setShowDate] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [offset, setOffset] = useState(0);
  const [groupEditor, setGroupEditor] = useState<
    "create" | "rename" | "delete" | null
  >(null);
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const list = useQuery({
    queryKey: listKey,
    queryFn: getWatchlist,
    enabled: visible,
    refetchInterval: visible ? 5000 : false,
  });
  const groups = list.data?.groups ?? [];
  const group =
    requestedGroup === "all" || groups.some((g) => g.id === requestedGroup)
      ? requestedGroup
      : "all";
  const sort = sorts[group] ?? null;
  const quotes = useQuery({
    queryKey: [...quotesKey, group],
    queryFn: () => getWatchlistQuotes(group),
    enabled: visible && Boolean(list.data),
    refetchInterval: visible ? 30000 : false,
  });
  const quoteMap = useMemo(
    () => new Map(quotes.data?.map((quote) => [quote.vt_symbol, quote])),
    [quotes.data],
  );
  const items = useMemo(
    () => list.data?.items.filter((item) => item.group_id === group) ?? [],
    [list.data, group],
  );
  const rows = useMemo(
    () => orderWatchlist(items, quoteMap, sort, frozen),
    [items, quoteMap, sort, frozen],
  );
  const selectedSymbols = rows
    .filter((row) => selected.has(row.vt_symbol))
    .map((row) => row.vt_symbol);
  const search = useQuery({
    queryKey: ["alpha", "watchlist-search", keyword, offset],
    queryFn: () => getAlphaSecurities({ q: keyword, limit: PAGE_SIZE, offset }),
    enabled: visible && searchOpen && Boolean(keyword),
  });
  const included = new Set(items.map((item) => item.vt_symbol));
  const change = useMutation({
    mutationFn: changeWatchlist,
    onMutate: async () => {
      await client.cancelQueries({ queryKey: listKey });
    },
    onSuccess: async (snapshot, command) => {
      // 命令返回后重新读取，避免延迟的写入响应覆盖其他窗口已提交的更新。
      await client.cancelQueries({ queryKey: listKey });
      await client.invalidateQueries({ queryKey: listKey });
      if (
        ["add", "remove", "copy", "move", "delete_group"].includes(
          command.action,
        )
      )
        void client.invalidateQueries({ queryKey: quotesKey });
      if (command.action === "create_group") {
        const created = snapshot.groups.find((g) => g.name === command.name);
        if (created) setGroup(created.id);
      }
      if (
        ["create_group", "rename_group", "delete_group"].includes(
          command.action,
        )
      )
        setGroupEditor(null);
      if (command.action === "delete_group") setGroup("all");
      if ("symbols" in command) {
        if (snapshot.transfer) {
          setNotice(
            t("watch.transferred", {
              count: snapshot.transfer.total,
              existing: snapshot.transfer.existing,
            }),
          );
        } else setNotice(t("watch.saved"));
      }
      setSelected(new Set());
      selectionAnchor.current = null;
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: listKey });
    },
  });
  const locked = change.isPending;
  const command = (value: WatchlistCommand) => {
    if (!locked) {
      setNotice("");
      change.mutate(value);
    }
  };
  useEffect(() => {
    // 其他窗口删除当前分组后，退出只针对旧分组的编辑状态。
    if (requestedGroup !== group) {
      setGroup(group);
      setEditing(false);
      setFrozen(null);
      setSelected(new Set());
      setGroupEditor(null);
    }
  }, [requestedGroup, group]);
  const finish = () => {
    setEditing(false);
    setSelected(new Set());
    setFrozen(null);
    selectionAnchor.current = null;
  };
  const toggleSort = (column: "change" | "date") => {
    setSorts((previous) => ({
      ...previous,
      [group]: {
        column,
        direction:
          sort?.column === column && sort.direction === "desc" ? "asc" : "desc",
      },
    }));
  };
  const toggle = (key: string, range: boolean) => {
    const anchor = selectionAnchor.current;
    setSelected((previous) =>
      toggleWatchlistSelection(previous, rows, key, anchor, range),
    );
    selectionAnchor.current = key;
  };
  const targets = groups.filter((target) => target.id !== group);
  const targetMenu = (action: "copy" | "move") => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          disabled={locked || !selectedSymbols.length || !targets.length}
        >
          {t(
            action === "copy" && group === "all"
              ? "watch.addToGroup"
              : `watch.${action}`,
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {targets.map((target) => (
          <DropdownMenuItem
            key={target.id}
            onSelect={() =>
              command({
                action,
                group_id: group,
                symbols: selectedSymbols,
                target_group_id: target.id,
              })
            }
          >
            {target.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const error = change.error ?? list.error ?? quotes.error;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 p-1">
        <Select
          value={group}
          disabled={editing || locked || !list.data}
          onValueChange={(value) => {
            setGroup(value);
            setFrozen(null);
            setSelected(new Set());
            setGroupEditor(null);
            setNotice("");
          }}
        >
          <SelectTrigger
            size="sm"
            className="min-w-0 flex-1"
            aria-label={t("watch.group")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("watch.all")}</SelectItem>
            {groups.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              disabled={editing || locked || !list.data}
            >
              {t("watch.manage")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              onSelect={() => {
                setGroupEditor("create");
                setName("");
              }}
            >
              {t("watch.createGroup")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={group === "all"}
              onSelect={() => {
                setGroupEditor("rename");
                setName(groups.find((g) => g.id === group)?.name ?? "");
              }}
            >
              {t("watch.renameGroup")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={group === "all"}
              variant="destructive"
              onSelect={() => setGroupEditor("delete")}
            >
              {t("watch.deleteGroup")}
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem
              checked={showDate}
              onCheckedChange={(value) => {
                setShowDate(value);
                if (!value)
                  setSorts((previous) =>
                    clearWatchlistColumnSort(previous, "date"),
                  );
              }}
            >
              {t("watch.dataDate")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {!editing && (
          <Button
            size="xs"
            variant="ghost"
            disabled={locked || !items.length || Boolean(groupEditor)}
            onClick={() => {
              setSearchOpen(false);
              setEditing(true);
              setFrozen(rows.map((row) => row.vt_symbol));
            }}
          >
            {t("watch.multi")}
          </Button>
        )}
        <Hint content={searchOpen ? undefined : t("watch.searchAdd")}>
          <Button
            size="icon-sm"
            variant={searchOpen ? "secondary" : "ghost"}
            aria-label={t("watch.searchAdd")}
            aria-haspopup="dialog"
            aria-expanded={searchOpen && visible}
            disabled={editing || locked || !list.data || Boolean(groupEditor)}
            onClick={() => setSearchOpen((open) => !open)}
          >
            <HugeiconsIcon icon={Search01Icon} size={16} />
          </Button>
        </Hint>
      </div>
      {groupEditor && (
        <form
          className="space-y-2 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            command(
              groupEditor === "delete"
                ? { action: "delete_group", group_id: group }
                : groupEditor === "create"
                  ? { action: "create_group", name: name.trim() }
                  : {
                      action: "rename_group",
                      group_id: group,
                      name: name.trim(),
                    },
            );
          }}
        >
          {groupEditor === "delete" ? (
            <p className="text-xs">{t("watch.deleteGroupHint")}</p>
          ) : (
            <Input
              focusTone="accent"
              aria-label={t("watch.groupName")}
              placeholder={t("watch.groupName")}
              maxLength={60}
              value={name}
              disabled={locked}
              onChange={(event) => setName(event.target.value)}
            />
          )}
          <div className="flex gap-1">
            <Button
              size="xs"
              type="submit"
              disabled={locked || (groupEditor !== "delete" && !name.trim())}
            >
              {t(groupEditor === "delete" ? "desk.remove" : "watch.save")}
            </Button>
            <WatchlistCancelButton
              disabled={locked}
              onClick={() => setGroupEditor(null)}
            >
              {t("watch.cancel")}
            </WatchlistCancelButton>
          </div>
        </form>
      )}
      {editing ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 p-1">
          <Checkbox
            disabled={locked || !rows.length}
            aria-label={t("watch.selectAll")}
            checked={
              selectedSymbols.length === rows.length && rows.length > 0
                ? true
                : selectedSymbols.length
                  ? "indeterminate"
                  : false
            }
            onCheckedChange={(checked) =>
              setSelected(
                new Set(checked ? rows.map((row) => row.vt_symbol) : []),
              )
            }
          />
          <span className="text-xs">
            {t("watch.selected", { count: selectedSymbols.length })}
          </span>
          {targetMenu("copy")}
          {group !== "all" && targetMenu("move")}
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={locked || !selectedSymbols.length}
            onClick={() =>
              command({
                action: "remove",
                group_id: group,
                symbols: selectedSymbols,
              })
            }
          >
            {t(group === "all" ? "watch.removeAll" : "watch.removeGroup")}
          </Button>
          <Button size="xs" disabled={locked} onClick={finish}>
            {t("watch.done")}
          </Button>
          <WatchlistCancelButton disabled={locked} onClick={finish}>
            {t("watch.cancelMulti")}
          </WatchlistCancelButton>
        </div>
      ) : null}
      {error && (
        <p role="alert" className="shrink-0 p-2 text-xs text-destructive">
          {t(`watch.errors.${error.message}`, {
            defaultValue: t("watch.failed"),
          })}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="shrink-0 px-2 py-1 text-xs text-muted-foreground"
        >
          {notice}
        </p>
      )}
      <WorkbenchPageWindow
        open={searchOpen && visible}
        onOpenChange={setSearchOpen}
        title={t("watch.searchAdd")}
        draggable
        className="left-12 right-auto top-12 w-96"
      >
        <div className="flex max-h-[min(28rem,60vh)] flex-col gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {t("watch.addTarget", {
              group:
                group === "all"
                  ? t("watch.all")
                  : groups.find((entry) => entry.id === group)?.name,
            })}
          </p>
          <form
            className="flex shrink-0 gap-1 p-1"
            onSubmit={(event) => {
              event.preventDefault();
              setKeyword(draft.trim());
              setOffset(0);
            }}
          >
            <Input
              focusTone="accent"
              aria-label={t("desk.search")}
              placeholder={t("desk.search")}
              value={draft}
              disabled={locked}
              onChange={(event) => {
                setDraft(event.target.value);
                if (!event.target.value.trim()) setKeyword("");
              }}
            />
            <Button size="xs" type="submit" variant="ghost" disabled={locked}>
              {t("desk.find")}
            </Button>
          </form>
          {search.error && (
            <p role="alert" className="text-xs text-destructive">
              {t("watch.failed")}
            </p>
          )}
          {keyword ? (
            <>
              <div className="app-scrollbar min-h-0 flex-1 overflow-auto">
                {search.isPending && (
                  <p className="p-2 text-xs">{t("common.loading")}</p>
                )}
                {search.data?.items.map((row) => (
                  <div key={row.vt_symbol} className="flex items-center p-1">
                    <Button
                      variant="ghost"
                      className="h-auto min-w-0 flex-1 flex-col items-start"
                      onClick={() => onSelect(row.vt_symbol)}
                    >
                      <span className="max-w-full truncate">{row.name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {row.vt_symbol}
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={
                        locked || !list.data || included.has(row.vt_symbol)
                      }
                      onClick={() =>
                        command({
                          action: "add",
                          group_id: group,
                          symbols: [row.vt_symbol],
                        })
                      }
                    >
                      {t(
                        included.has(row.vt_symbol)
                          ? "watch.added"
                          : "desk.add",
                      )}
                    </Button>
                  </div>
                ))}
                {!search.isPending && search.data?.items.length === 0 && (
                  <p className="p-2 text-xs text-muted-foreground">
                    {t("desk.noResults")}
                  </p>
                )}
              </div>
              <div className="flex justify-between p-1">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={offset === 0 || search.isFetching}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  {t("desk.previous")}
                </Button>
                <span className="text-xs">
                  {t("desk.resultCount", { count: search.data?.total ?? 0 })}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={
                    search.isFetching ||
                    offset + PAGE_SIZE >= (search.data?.total ?? 0)
                  }
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  {t("desk.next")}
                </Button>
              </div>
            </>
          ) : (
            <p className="py-4 text-xs text-muted-foreground">
              {t("desk.search")}
            </p>
          )}
        </div>
      </WorkbenchPageWindow>

      <WatchlistTable
        key={group}
        rows={rows}
        quoteMap={quoteMap}
        groups={groups}
        symbol={symbol}
        editing={editing}
        selected={selected}
        locked={locked}
        sort={sort}
        showDate={showDate}
        visible={visible}
        pending={list.isPending}
        onSelect={onSelect}
        onToggle={toggle}
        onCommand={command}
        onFreeze={setFrozen}
        onSort={toggleSort}
        onCancelSort={() =>
          setSorts((previous) => ({ ...previous, [group]: null }))
        }
      />
    </div>
  );
}
