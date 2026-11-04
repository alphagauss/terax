/**
 * 本文件实现轻量的工作区内容搜索侧边栏。
 * 面板按需调用统一搜索后端并在内存中保留查询，不建立索引、监听器或持久搜索历史。
 */

import {
  useViewActive,
  useViewState,
  useViewCommand,
  useViewScroll,
} from "@/modules/view-state";
import { Hint } from "@/components/controls/tooltip";
import { Button } from "@/components/controls/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  FindControlButton,
  type FindOptions,
  FindPatternField,
  type FindPatternFieldHandle,
} from "@/modules/find";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import ListChevronsDownUpIcon from "@hugeicons/core-free-icons/ListChevronsDownUpIcon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon";
import Refresh01Icon from "@hugeicons/core-free-icons/Refresh01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  cancelContentSearch,
  searchContent,
  type ContentSearchHit,
  type ContentSearchResponse,
} from "@/modules/workspace-search/api";
import {
  groupContentHits,
  parseGlobInput,
} from "@/modules/workspace-search/model";

const SEARCH_DEBOUNCE_MS = 220;
const SEARCH_RESULT_LIMIT = 500;
const SEARCH_PREVIEW_MAX_LENGTH = 160;
const SEARCH_PREVIEW_BEFORE_MATCH = 48;
const INVALID_REGEX_PREFIX = "invalid regular expression:";

export type WorkspaceSearchPanelHandle = {
  focus: () => void;
};

type Props = {
  rootPath: string | null;
  visible: boolean;
  onOpenHit: (hit: ContentSearchHit) => void;
};

/** 工作区内容搜索面板。 */
export const WorkspaceSearchPanel = forwardRef<
  WorkspaceSearchPanelHandle,
  Props
>(function WorkspaceSearchPanel(
  { rootPath, visible: requestedVisible, onOpenHit },
  ref,
) {
  const { t } = useTranslation("workspaceSearch");
  const patternRef = useRef<FindPatternFieldHandle>(null);
  const requestIdRef = useRef(0);
  const visible = useViewActive(requestedVisible);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useViewState(`query:${rootPath}`, "");
  const [options, setOptions] = useViewState<FindOptions>(
    `options:${rootPath}`,
    {
      caseSensitive: false,
      wholeWord: false,
      regexp: false,
    },
  );
  const [detailsOpen, setDetailsOpen] = useViewState(
    `details:${rootPath}`,
    false,
  );
  const [includeInput, setIncludeInput] = useViewState(
    `include:${rootPath}`,
    "",
  );
  const [excludeInput, setExcludeInput] = useViewState(
    `exclude:${rootPath}`,
    "",
  );
  const [response, setResponse] = useViewState<ContentSearchResponse | null>(
    `response:${rootPath}`,
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useViewState<string | null>(
    `error:${rootPath}`,
    null,
  );
  const [refreshVersion, setRefreshVersion] = useViewState(
    `refresh:${rootPath}`,
    0,
  );
  const [collapsedFiles, setCollapsedFiles] = useViewState<Set<string>>(
    `collapsed:${rootPath}`,
    () => new Set(),
  );
  const [selectedHitKey, setSelectedHitKey] = useViewState<string | null>(
    `selected:${rootPath}`,
    null,
  );

  const groups = useMemo(
    () => groupContentHits(response?.hits ?? []),
    [response],
  );
  const allFilesCollapsed =
    groups.length > 0 && groups.every((group) => collapsedFiles.has(group.rel));
  const invalidRegex = Boolean(
    options.regexp && error?.startsWith(INVALID_REGEX_PREFIX),
  );
  const invalidGlob = Boolean(
    error?.startsWith("bad glob") || error?.startsWith("globset build"),
  );

  const focus = useCallback(() => {
    requestAnimationFrame(() => patternRef.current?.focus(true));
  }, []);
  useImperativeHandle(ref, () => ({ focus }), [focus]);

  const requestKey = JSON.stringify([
    rootPath,
    query,
    options,
    includeInput,
    excludeInput,
    refreshVersion,
  ]);
  useViewCommand("content-search", requestKey, visible, () => {
    const requestId = ++requestIdRef.current;
    const pattern = query;
    if (!visible || !rootPath) {
      setLoading(false);
      return;
    }
    if (pattern.length === 0) {
      setResponse(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    let searchActive = false;
    const handle = window.setTimeout(() => {
      searchActive = true;
      void searchContent({
        root: rootPath,
        pattern,
        syntax: options.regexp ? "regex" : "literal",
        caseMode: options.caseSensitive ? "sensitive" : "insensitive",
        wholeWord: options.wholeWord,
        includes: parseGlobInput(includeInput),
        excludes: parseGlobInput(excludeInput),
        maxResults: SEARCH_RESULT_LIMIT,
        cancelPrevious: true,
      })
        .then((next) => {
          if (requestId !== requestIdRef.current) return;
          setResponse(next);
          setCollapsedFiles((current) => {
            const paths = new Set(next.hits.map((hit) => hit.rel));
            return new Set([...current].filter((path) => paths.has(path)));
          });
          setSelectedHitKey((current) =>
            current && next.hits.some((hit) => hitKey(hit) === current)
              ? current
              : null,
          );
        })
        .catch((reason) => {
          if (requestId !== requestIdRef.current) return;
          setResponse(null);
          setError(String(reason));
        })
        .finally(() => {
          searchActive = false;
          if (requestId === requestIdRef.current) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
      requestIdRef.current++;
      setLoading(false);
      if (searchActive) void cancelContentSearch(rootPath).catch(() => {});
    };
  });
  const resultKeys = useMemo(
    () =>
      groups.flatMap((group) => [
        group.rel,
        ...(collapsedFiles.has(group.rel) ? [] : group.hits.map(hitKey)),
      ]),
    [groups, collapsedFiles],
  );
  const attachScroll = useViewScroll("results", scrollRef, resultKeys, visible);

  const clear = () => {
    requestIdRef.current += 1;
    setQuery("");
    setResponse(null);
    setLoading(false);
    setError(null);
    setCollapsedFiles(new Set());
    setSelectedHitKey(null);
    focus();
  };

  const changeOptionFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey)
      return;
    const key = event.key.toLowerCase();
    if (key === "c")
      setOptions((current) => ({
        ...current,
        caseSensitive: !current.caseSensitive,
      }));
    else if (key === "w")
      setOptions((current) => ({ ...current, wholeWord: !current.wholeWord }));
    else if (key === "r")
      setOptions((current) => ({ ...current, regexp: !current.regexp }));
    else return;
    event.preventDefault();
    patternRef.current?.focus();
  };

  const toggleAllFiles = () =>
    setCollapsedFiles(
      allFilesCollapsed ? new Set() : new Set(groups.map((group) => group.rel)),
    );

  return (
    <section
      aria-label={t("title")}
      onKeyDown={changeOptionFromKeyboard}
      className="flex h-full min-h-0 flex-col bg-sidebar"
    >
      <header className="flex h-8 shrink-0 items-center border-b border-border/50 px-2">
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium">
          {t("title")}
        </h2>
        <div className="flex items-center gap-0.5">
          <ToolbarButton
            label={t("refresh")}
            disabled={!rootPath || query.length === 0 || loading}
            onClick={() => setRefreshVersion((value) => value + 1)}
          >
            {loading ? (
              <Spinner className="size-3" />
            ) : (
              <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.9} />
            )}
          </ToolbarButton>
          <ToolbarButton
            label={t("clear")}
            disabled={query.length === 0 && !response}
            onClick={clear}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.9} />
          </ToolbarButton>
          <ToolbarButton
            label={t(allFilesCollapsed ? "expandAll" : "collapseAll")}
            disabled={groups.length === 0}
            onClick={toggleAllFiles}
          >
            <HugeiconsIcon
              icon={ListChevronsDownUpIcon}
              size={13}
              strokeWidth={1.9}
            />
          </ToolbarButton>
        </div>
      </header>

      <div className="shrink-0 border-b border-border/40 px-2 py-2">
        <FindPatternField
          ref={patternRef}
          query={query}
          onQueryChange={setQuery}
          options={options}
          onOptionsChange={setOptions}
          invalid={invalidRegex}
          placeholder={t("searchPlaceholder")}
        />
        <div className="mt-0.5 flex justify-end">
          <FindControlButton
            label={detailsOpen ? t("hideDetails") : t("showDetails")}
            active={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <HugeiconsIcon
              icon={MoreHorizontalIcon}
              size={14}
              strokeWidth={1.9}
            />
          </FindControlButton>
        </div>
        {detailsOpen ? (
          <div className="mt-1.5 space-y-2">
            <FilterField
              label={t("includeFiles")}
              value={includeInput}
              placeholder={t("includePlaceholder")}
              onChange={setIncludeInput}
            />
            <FilterField
              label={t("excludeFiles")}
              value={excludeInput}
              placeholder={t("excludePlaceholder")}
              onChange={setExcludeInput}
            />
            <p className="text-[11px] leading-4 text-muted-foreground">
              {t("ignoreHint")}
            </p>
          </div>
        ) : null}
      </div>

      <div
        ref={attachScroll}
        className="app-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
      >
        <div className="py-1">
          {!rootPath ? (
            <EmptyState>{t("noWorkspace")}</EmptyState>
          ) : query.length === 0 ? (
            <EmptyState>{t("emptyQuery")}</EmptyState>
          ) : error ? (
            <EmptyState tone={invalidRegex || invalidGlob ? "error" : "muted"}>
              {invalidRegex
                ? t("invalidRegex")
                : invalidGlob
                  ? t("invalidGlob")
                  : t("searchFailed")}
            </EmptyState>
          ) : loading && !response ? (
            <EmptyState>{t("searching")}</EmptyState>
          ) : groups.length === 0 ? (
            <EmptyState>{t("noResults")}</EmptyState>
          ) : (
            <>
              <div className="px-2 pb-1 text-[11px] tabular-nums text-muted-foreground">
                {t("summary", {
                  files: groups.length,
                  matches: response?.hits.length ?? 0,
                })}
              </div>
              {response?.truncated ? (
                <div className="mx-2 mb-1 rounded border border-warning/35 bg-warning/8 px-2 py-1 text-[11px] text-warning">
                  {t("truncated", { count: SEARCH_RESULT_LIMIT })}
                </div>
              ) : null}
              {groups.map((group) => {
                const collapsed = collapsedFiles.has(group.rel);
                return (
                  <div key={group.rel}>
                    <button
                      type="button"
                      data-view-row={group.rel}
                      aria-expanded={!collapsed}
                      onClick={() =>
                        setCollapsedFiles((current) => {
                          const next = new Set(current);
                          if (collapsed) next.delete(group.rel);
                          else next.add(group.rel);
                          return next;
                        })
                      }
                      className="flex h-6 w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-[13px] hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
                        <HugeiconsIcon
                          icon={ArrowRight01Icon}
                          size={12}
                          strokeWidth={2.25}
                          className={
                            collapsed
                              ? "transition-transform duration-control"
                              : "rotate-90 transition-transform duration-control"
                          }
                        />
                      </span>
                      <img
                        src={fileIconUrl(basename(group.rel))}
                        alt=""
                        className="file-type-icon size-4 shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {basename(group.rel)}
                      </span>
                      <span className="min-w-0 max-w-[42%] truncate text-[11px] text-muted-foreground">
                        {dirname(group.rel)}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {group.hits.length}
                      </span>
                    </button>
                    {!collapsed
                      ? group.hits.map((hit) => (
                          <Hint
                            content={`${hit.rel}:${hit.line}`}
                            key={hitKey(hit)}
                          >
                            <button
                              data-view-row={hitKey(hit)}
                              aria-label={`${hit.rel}:${hit.line}`}
                              type="button"
                              aria-current={
                                selectedHitKey === hitKey(hit)
                                  ? "true"
                                  : undefined
                              }
                              onClick={() => {
                                setSelectedHitKey(hitKey(hit));
                                onOpenHit(hit);
                              }}
                              className={cn(
                                "flex h-6 w-full min-w-0 items-center gap-2 rounded-sm pr-2 pl-2 text-left font-mono text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                                selectedHitKey === hitKey(hit)
                                  ? "bg-primary/12 text-foreground ring-1 ring-inset ring-primary/70"
                                  : "hover:bg-interactive-hover",
                              )}
                            >
                              <span className="w-7 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                                {hit.line}
                              </span>
                              <span className="min-w-0 flex-1 truncate whitespace-pre">
                                <HighlightedLine hit={hit} />
                              </span>
                            </button>
                          </Hint>
                        ))
                      : null}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </section>
  );
});

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Hint content={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </Button>
    </Hint>
  );
}

function FilterField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-foreground">{label}</span>
      <input
        type="text"
        value={value}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 w-full rounded-md border border-input bg-background/75 px-2 text-xs outline-none placeholder:text-muted-foreground/65 focus:border-ring"
      />
    </label>
  );
}

function EmptyState({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={
        tone === "error"
          ? "px-3 py-6 text-center text-xs text-destructive"
          : "px-3 py-6 text-center text-xs text-muted-foreground"
      }
    >
      {children}
    </div>
  );
}

function HighlightedLine({ hit }: { hit: ContentSearchHit }) {
  const preview = createLinePreview(hit);
  if (preview.ranges.length === 0) return preview.text;
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const range of preview.ranges) {
    if (range.start < offset || range.end <= range.start) continue;
    parts.push(preview.text.slice(offset, range.start));
    parts.push(
      <mark
        key={`${range.start}:${range.end}`}
        className="rounded-sm bg-primary/20 text-foreground"
      >
        {preview.text.slice(range.start, range.end)}
      </mark>,
    );
    offset = range.end;
  }
  parts.push(preview.text.slice(offset));
  return parts;
}

/**
 * 围绕首个匹配构造侧边栏摘要。
 * 只转换展示文本和高亮坐标，点击跳转继续使用后端返回的完整行坐标。
 */
function createLinePreview(
  hit: ContentSearchHit,
): Pick<ContentSearchHit, "text" | "ranges"> {
  const firstMatch = hit.ranges.find((range) => range.end > range.start);
  const leadingWhitespace = hit.text.match(/^[\t ]*/)?.[0].length ?? 0;
  const contentStart =
    firstMatch && firstMatch.start < leadingWhitespace ? 0 : leadingWhitespace;
  let start = contentStart;
  let end = hit.text.length;

  if (end - start > SEARCH_PREVIEW_MAX_LENGTH) {
    if (firstMatch) {
      const matchStart = Math.max(contentStart, firstMatch.start);
      const matchEnd = Math.max(matchStart, firstMatch.end);
      const matchLength = matchEnd - matchStart;
      if (matchLength >= SEARCH_PREVIEW_MAX_LENGTH) {
        start = matchStart;
        end = Math.min(hit.text.length, start + SEARCH_PREVIEW_MAX_LENGTH);
      } else {
        const before = Math.min(
          SEARCH_PREVIEW_BEFORE_MATCH,
          SEARCH_PREVIEW_MAX_LENGTH - matchLength,
        );
        start = Math.max(contentStart, matchStart - before);
        end = Math.min(hit.text.length, start + SEARCH_PREVIEW_MAX_LENGTH);
        if (end < matchEnd) {
          end = matchEnd;
          start = Math.max(contentStart, end - SEARCH_PREVIEW_MAX_LENGTH);
        }
      }
    } else {
      end = start + SEARCH_PREVIEW_MAX_LENGTH;
    }
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < hit.text.length ? "…" : "";
  const prefixLength = prefix.length;
  const ranges = hit.ranges
    .map((range) => ({
      start: prefixLength + Math.max(range.start, start) - start,
      end: prefixLength + Math.min(range.end, end) - start,
    }))
    .filter((range) => range.end > range.start);

  return {
    text: `${prefix}${hit.text.slice(start, end)}${suffix}`,
    ranges,
  };
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function hitKey(hit: ContentSearchHit): string {
  return `${hit.path}:${hit.line}`;
}
