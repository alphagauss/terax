/**
 * 本文件实现 Source Control 的提交图谱区域。
 * 负责提交列表与分页，复用悬停详情及多提交文件展开交互。
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/controls/alert-dialog";
import { Button } from "@/components/controls/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { type GitLogEntry, native } from "@/modules/ai/lib/native";
import {
  FindControlButton,
  FindPatternField,
  type FindPatternFieldHandle,
} from "@/modules/find";
import { CommitDetail } from "@/modules/git-history/CommitDetail";
import {
  CommitHoverCard,
  commitRowInteraction,
  ExpandedCommitRow,
} from "@/modules/git-history/CommitGraphInteraction";
import { useCommitRowReveal } from "@/modules/git-history/useCommitRowReveal";
import { GraphRail } from "@/modules/git-history/GraphRail";
import { layoutGraph } from "@/modules/git-history/lib/graph";
import {
  commitWebUrl,
  hostLabel,
  parseRemoteWebUrl,
  type RemoteWebInfo,
} from "@/modules/git-history/lib/remoteWebUrl";
import {
  flattenCommitRows,
  useCommitGraph,
} from "@/modules/git-history/useCommitGraph";
import { relativeTime } from "@/modules/source-control/relativeTime";
import {
  ArrowDown01Icon,
  Cancel01Icon,
  CloudIcon,
  GitBranchIcon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { reportError } from "@/lib/errors";

const PAGE_SIZE = 40;
// 与原生 git-log 的单页上限一致，搜索按页继续扫描历史。
const SEARCH_PAGE_SIZE = 200;
const ROW_HEIGHT = 24;
const NEAR_BOTTOM_PX = 180;
const SEARCH_FIELDS = ["subject", "author", "authorEmail", "sha"] as const;
type SearchField = (typeof SEARCH_FIELDS)[number];

/** 只装饰提交说明中的匹配片段，保留原始文本与文件打开协议。 */
function highlightSubject(subject: string, query: string): ReactNode {
  if (!query) return subject;
  const text = subject.toLowerCase();
  const pattern = query.toLowerCase();
  const parts: ReactNode[] = [];
  let offset = 0;
  let index = text.indexOf(pattern);
  while (index !== -1) {
    parts.push(subject.slice(offset, index));
    parts.push(
      <mark key={index} className="rounded-sm bg-primary/20 text-foreground">
        {subject.slice(index, index + query.length)}
      </mark>,
    );
    offset = index + query.length;
    index = text.indexOf(pattern, offset);
  }
  parts.push(subject.slice(offset));
  return parts;
}

type CommitFileDiffOpenInput = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

type Props = {
  repoRoot: string | null;
  headBranch: string | null;
  headSha: string | null;
  expanded: boolean;
  /** 展示退出结束后释放 DOM 和虚拟器观测，控制层保留提交状态。 */
  present?: boolean;
  refreshToken: number;
  graphRevision: string;
  showUndoCommit: boolean;
  mayHavePushedHead: boolean;
  onDidUndo: () => void;
  onOpenCommitFile?: (input: CommitFileDiffOpenInput) => void;
  searchOpen?: boolean;
  onCloseSearch?: () => void;
};

type LoadStatus = "idle" | "initial" | "more" | "initial-error" | "more-error";
function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown Git error";
}

/**
 * Source Control 提交图谱区域。
 *
 * 渲染可分页的提交列表，并管理当前提交详情及一致的行交互状态。
 */
export const GraphSection = memo(function GraphSection({
  repoRoot,
  headBranch,
  headSha,
  expanded,
  present = expanded,
  refreshToken,
  graphRevision,
  showUndoCommit,
  mayHavePushedHead,
  onDidUndo,
  onOpenCommitFile,
  searchOpen = false,
  onCloseSearch,
}: Props) {
  const { t } = useTranslation("gitHistory");
  const [searchInput, setSearchInput] = useState("");
  const [searchField, setSearchField] = useState<SearchField>("subject");
  const searchFieldRef = useRef<FindPatternFieldHandle>(null);
  const activeSearch = searchOpen ? searchInput.trim() : "";
  const [remoteWeb, setRemoteWeb] = useState<RemoteWebInfo | null>(null);
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [endReached, setEndReached] = useState(false);
  const graph = useCommitGraph(repoRoot, expanded);
  const {
    anchor: openAnchor,
    files: filesBySha,
    fetchFiles,
    close: closePopover,
    reset,
  } = graph;
  const [pendingUndo, setPendingUndo] = useState<GitLogEntry | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{
    sha: string;
    path: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  const attachScroll = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    if (element) element.scrollTop = scrollTop.current;
  }, []);
  const requestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const loadedKeyRef = useRef<string | null>(null);
  const refreshKey = repoRoot
    ? `${repoRoot}:${headBranch ?? ""}:${headSha ?? ""}:${graphRevision}:${refreshToken}`
    : null;

  useEffect(() => {
    if (!searchOpen) setSearchInput("");
  }, [searchOpen]);

  useEffect(() => {
    let cancelled = false;
    setRemoteWeb(null);
    if (repoRoot)
      void native
        .gitRemoteUrl(repoRoot)
        .then((url) => {
          if (!cancelled) setRemoteWeb(parseRemoteWebUrl(url));
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  const loadInitial = useCallback(async () => {
    if (!repoRoot || !expanded) return;
    const request = ++requestRef.current;
    loadingMoreRef.current = false;
    setLoadStatus("initial");
    setError(null);
    setEndReached(false);
    try {
      const next = await native.gitLog(repoRoot, { limit: PAGE_SIZE });
      if (request !== requestRef.current) return;
      loadedKeyRef.current = refreshKey;
      setCommits(next);
      setEndReached(next.length < PAGE_SIZE);
      setLoadStatus("idle");
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 }));
    } catch (loadError) {
      if (request !== requestRef.current) return;
      setError(normalizeError(loadError));
      setLoadStatus("initial-error");
    }
  }, [expanded, repoRoot, refreshKey]);

  useEffect(() => {
    if (!expanded || !refreshKey) return;
    if (loadedKeyRef.current === refreshKey) return;
    setSelectedFile(null);
    reset();
    void loadInitial();
  }, [expanded, loadInitial, refreshKey, reset]);

  useEffect(() => {
    setPendingUndo((current) => (current?.sha === headSha ? current : null));
  }, [headSha]);

  useEffect(() => {
    return () => {
      requestRef.current += 1;
    };
  }, []);

  const loadMore = useCallback(async () => {
    if (
      !expanded ||
      !repoRoot ||
      endReached ||
      loadingMoreRef.current ||
      commits.length === 0 ||
      (loadStatus !== "idle" && loadStatus !== "more-error")
    ) {
      return;
    }
    const request = requestRef.current;
    loadingMoreRef.current = true;
    setLoadStatus("more");
    setError(null);
    const limit = activeSearch ? SEARCH_PAGE_SIZE : PAGE_SIZE;
    try {
      const next = await native.gitLog(repoRoot, {
        limit,
        skip: commits.length,
      });
      if (request !== requestRef.current) return;
      setCommits((current) => {
        const known = new Set(current.map((commit) => commit.sha));
        return current.concat(next.filter((commit) => !known.has(commit.sha)));
      });
      setEndReached(next.length < limit);
      setLoadStatus("idle");
    } catch (loadError) {
      if (request !== requestRef.current) return;
      setError(normalizeError(loadError));
      setLoadStatus("more-error");
    } finally {
      if (request === requestRef.current) loadingMoreRef.current = false;
    }
  }, [activeSearch, commits, endReached, expanded, loadStatus, repoRoot]);

  // 每行仅为自身轨道留白，追加历史中的复杂分支不能推移已有提交。
  const { rows: graphRows } = useMemo(() => layoutGraph(commits), [commits]);
  const graphBySha = useMemo(
    () => new Map(graphRows.map((row) => [row.sha, row])),
    [graphRows],
  );

  const filtered = useMemo(() => {
    const query = activeSearch.toLowerCase();
    if (!query) return commits;
    return commits.filter((commit) =>
      commit[searchField].toLowerCase().includes(query),
    );
  }, [activeSearch, commits, searchField]);
  const items = useMemo(
    () => flattenCommitRows(filtered, graph.expanded, filesBySha),
    [filtered, graph.expanded, filesBySha],
  );
  const virtualizer = useVirtualizer({
    enabled: present,
    initialOffset: () => scrollTop.current,
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => items[index]?.key ?? index,
  });

  const reveal = useCommitRowReveal(
    items,
    virtualizer.getVirtualItems(),
    scrollRef,
    ROW_HEIGHT,
    `${repoRoot}:${activeSearch}:${searchField}`,
    expanded,
  );
  const toggleCommit = (sha: string) => {
    reveal.capture(sha);
    if (graph.expanded.has(sha) && selectedFile?.sha === sha)
      setSelectedFile(null);
    graph.toggle(sha);
  };
  const renderRow = (row: (typeof reveal.rows)[number], content: ReactNode) => (
    <div
      key={row.item.key}
      data-commit-row={row.item.key}
      ref={(element) => {
        if (element) reveal.elements.current.set(row.item.key, element);
        else reveal.elements.current.delete(row.item.key);
      }}
      inert={row.exiting}
      aria-hidden={row.exiting || undefined}
      className="pointer-events-none absolute left-0 w-full overflow-hidden"
      style={{
        // 基础位置使用布局坐标，展开动画继续使用独立的 translate。
        top: row.start,
        height: row.exiting ? 0 : row.size,
      }}
    >
      <div
        className="pointer-events-none overflow-hidden"
        style={{ height: row.size }}
      >
        <div className="pointer-events-auto h-full">{content}</div>
      </div>
    </div>
  );

  useEffect(() => {
    if (!expanded || loadStatus !== "idle" || endReached) return;
    const scroll = scrollRef.current;
    if (
      activeSearch ||
      (scroll && scroll.scrollHeight <= scroll.clientHeight + NEAR_BOTTOM_PX)
    ) {
      const timer = window.setTimeout(() => void loadMore(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [activeSearch, endReached, expanded, loadMore, loadStatus]);

  const confirmUndo = useCallback(async () => {
    if (!repoRoot || !pendingUndo) return;
    setUndoing(true);
    try {
      await native.gitUndoCommit(repoRoot, pendingUndo.sha);
      setPendingUndo(null);
      closePopover();
      toast.success("Commit undone", {
        description: "The commit changes remain staged.",
      });
      onDidUndo();
    } catch (undoError) {
      reportError(t("common:errors.undoCommitFailed"), {
        description: normalizeError(undoError),
      });
    } finally {
      setUndoing(false);
    }
  }, [closePopover, onDidUndo, pendingUndo, repoRoot, t]);

  const selectedCommit = openAnchor
    ? (commits.find((commit) => commit.sha === openAnchor.sha) ?? null)
    : null;
  const selectedFiles = selectedCommit
    ? (filesBySha.get(selectedCommit.sha) ?? null)
    : null;

  if (!present) return null;

  if (!repoRoot) {
    return <GraphPlaceholder>No Git repository.</GraphPlaceholder>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar [contain:layout_style]">
      {searchOpen && expanded ? (
        <form
          aria-label={t("searchHistory")}
          onSubmit={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCloseSearch?.();
            }
          }}
          className="flex shrink-0 flex-col gap-1 border-b border-border/50 p-1.5"
        >
          <div className="flex items-center gap-1">
            <FindPatternField
              ref={searchFieldRef}
              query={searchInput}
              autoFocus
              placeholder={t("searchPlaceholder", {
                field: t(`searchFields.${searchField}`),
              })}
              trailingContent={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label={t("searchCategory")}
                      className="gap-1 whitespace-nowrap"
                    >
                      {t(`searchFields.${searchField}`)}
                      <HugeiconsIcon icon={ArrowDown01Icon} size={11} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    onCloseAutoFocus={(event) => {
                      event.preventDefault();
                      searchFieldRef.current?.focus();
                    }}
                  >
                    <DropdownMenuRadioGroup
                      value={searchField}
                      onValueChange={(value) => {
                        const field = SEARCH_FIELDS.find(
                          (candidate) => candidate === value,
                        );
                        if (!field) return;
                        closePopover();
                        setSearchField(field);
                        scrollRef.current?.scrollTo({ top: 0 });
                      }}
                    >
                      {SEARCH_FIELDS.map((field) => (
                        <DropdownMenuRadioItem key={field} value={field}>
                          {t(`searchFields.${field}`)}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
              onQueryChange={(value) => {
                closePopover();
                setSearchInput(value);
                scrollRef.current?.scrollTo({ top: 0 });
              }}
            />
            <FindControlButton
              label={t("closeSearch")}
              onClick={() => onCloseSearch?.()}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={13} />
            </FindControlButton>
          </div>
          {activeSearch ? (
            <div
              role="status"
              className="px-1 text-[10.5px] text-muted-foreground"
            >
              {t("searchResults", { count: filtered.length })}
              {!endReached &&
              loadStatus !== "more-error" &&
              loadStatus !== "initial-error"
                ? ` · ${t("searchingHistory")}`
                : ""}
            </div>
          ) : null}
        </form>
      ) : null}
      {loadStatus === "initial" && commits.length === 0 ? (
        <GraphPlaceholder>
          <Spinner className="size-3.5" /> Loading commits…
        </GraphPlaceholder>
      ) : loadStatus === "initial-error" && commits.length === 0 ? (
        <GraphPlaceholder>
          <span className="text-destructive">{error}</span>
          <Button size="xs" variant="ghost" onClick={() => void loadInitial()}>
            Retry
          </Button>
        </GraphPlaceholder>
      ) : commits.length === 0 ? (
        <GraphPlaceholder>No commits yet.</GraphPlaceholder>
      ) : (
        /* biome-ignore lint/a11y/noStaticElementInteractions: 容器只观察滚动和后代交互以释放虚拟列表预留空间，不是独立控件。 */
        <div
          ref={attachScroll}
          onWheel={reveal.releaseScrollSpace}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget)
              reveal.releaseScrollSpace();
          }}
          onKeyDown={(event) => {
            if (
              [
                "ArrowUp",
                "ArrowDown",
                "PageUp",
                "PageDown",
                "Home",
                "End",
                " ",
              ].includes(event.key)
            )
              reveal.releaseScrollSpace();
          }}
          onScroll={(event) => {
            reveal.finish();
            closePopover();
            const target = event.currentTarget;
            if (expanded) scrollTop.current = target.scrollTop;
            if (
              target.scrollHeight - target.scrollTop - target.clientHeight <
              NEAR_BOTTOM_PX
            ) {
              void loadMore();
            }
          }}
          className="app-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] [overflow-anchor:none]"
        >
          {activeSearch && filtered.length === 0 && endReached ? (
            <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
              {t("noSearchResults")}
            </div>
          ) : null}
          <div
            style={{
              height: virtualizer.getTotalSize(),
              minHeight: reveal.minimumHeight,
              position: "relative",
              width: "100%",
            }}
          >
            <div
              ref={reveal.boundaryRef}
              aria-hidden
              className="pointer-events-none absolute left-0 h-0 w-0"
            />
            {reveal.rows.map((virtualRow) => {
              const item = virtualRow.item;
              const commit = item?.commit;
              const graphRow = commit ? graphBySha.get(commit.sha) : null;
              if (!item || !commit || !graphRow) return null;
              if (item.kind !== "commit")
                return renderRow(
                  virtualRow,
                  <ExpandedCommitRow
                    item={item}
                    row={graphRow}
                    maxLaneCount={graphRow.laneCount}
                    rowHeight={ROW_HEIGHT}
                    selected={
                      item.kind === "file" &&
                      selectedFile?.sha === commit.sha &&
                      selectedFile.path === item.file.path
                    }
                    onRetry={() => void fetchFiles(commit.sha, true)}
                    onOpen={() => {
                      if (item.kind === "file") {
                        setSelectedFile({
                          sha: commit.sha,
                          path: item.file.path,
                        });
                        onOpenCommitFile?.({
                          repoRoot,
                          sha: commit.sha,
                          shortSha: commit.shortSha,
                          subject: commit.subject,
                          path: item.file.path,
                          originalPath: item.file.originalPath,
                        });
                      }
                    }}
                  />,
                );
              const refs = commit.refs.slice(0, 2);
              const hasLocalRef = refs.some((ref) => ref.kind === "local");
              return renderRow(
                virtualRow,
                <button
                  {...commitRowInteraction(
                    { ...graph, toggle: toggleCommit },
                    commit.sha,
                  )}
                  aria-label={`${commit.shortSha} ${commit.subject}`}
                  type="button"
                  onClick={() => toggleCommit(commit.sha)}
                  className={cn(
                    "group flex h-full w-full cursor-pointer items-center pr-2 text-left transition-colors hover:bg-interactive-hover",
                    graph.expanded.has(commit.sha) &&
                      "bg-interactive-active hover:bg-interactive-active",
                  )}
                >
                  <GraphRail
                    row={graphRow}
                    rowHeight={ROW_HEIGHT}
                    maxLaneCount={graphRow.laneCount}
                    active={graph.expanded.has(commit.sha)}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                    {commit.subject
                      ? highlightSubject(
                          commit.subject,
                          searchField === "subject" ? activeSearch : "",
                        )
                      : t("noSubject")}
                  </span>
                  {refs.map((ref) => (
                    <GitRefBadge
                      key={`${ref.kind}:${ref.label}`}
                      ref={ref}
                      iconOnly={hasLocalRef && ref.kind === "remote"}
                    />
                  ))}
                  <span className="ml-1.5 w-6 shrink-0 text-right font-mono text-[9.5px] tabular-nums text-muted-foreground">
                    {relativeTime(commit.timestampSecs)}
                  </span>
                </button>,
              );
            })}
          </div>
          {loadStatus === "more" ? (
            <div className="flex items-center justify-center gap-1.5 py-2 text-[10.5px] text-muted-foreground">
              <Spinner className="size-3" /> Loading more…
            </div>
          ) : null}
          {(loadStatus === "initial-error" || loadStatus === "more-error") &&
          commits.length > 0 ? (
            <div className="flex items-center justify-center gap-1.5 py-2 text-[10.5px] text-destructive">
              <span className="max-w-40 truncate">{error}</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={
                  loadStatus === "initial-error"
                    ? () => void loadInitial()
                    : () => void loadMore()
                }
              >
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <CommitHoverCard graph={graph} side="right">
        {selectedCommit ? (
          <CommitDetail
            key={selectedCommit.sha}
            commit={selectedCommit}
            filesEntry={selectedFiles}
            remoteAction={
              remoteWeb
                ? {
                    label: t("viewOn", { host: hostLabel(remoteWeb) }),
                    onClick: () =>
                      void openUrl(
                        commitWebUrl(remoteWeb, selectedCommit.sha),
                      ).catch(console.error),
                  }
                : undefined
            }
            onUndo={
              showUndoCommit &&
              selectedCommit.sha === headSha &&
              selectedCommit.parents.length > 0
                ? () => setPendingUndo(selectedCommit)
                : undefined
            }
            onRetry={() => void fetchFiles(selectedCommit.sha, true)}
            onOpenFile={(file) => {
              if (!onOpenCommitFile) return;
              setSelectedFile({ sha: selectedCommit.sha, path: file.path });
              onOpenCommitFile({
                repoRoot,
                sha: selectedCommit.sha,
                shortSha: selectedCommit.shortSha,
                subject: selectedCommit.subject,
                path: file.path,
                originalPath: file.originalPath,
              });
              closePopover();
            }}
          />
        ) : null}
      </CommitHoverCard>

      <AlertDialog
        open={!!pendingUndo}
        onOpenChange={(next) => {
          if (!next && !undoing) setPendingUndo(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo last commit?</AlertDialogTitle>
            <AlertDialogDescription>
              The commit will be removed from this branch and its changes will
              remain staged.
              {mayHavePushedHead
                ? " This commit may already be on the upstream branch. Rewriting it locally can require a force push."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={undoing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={undoing}
              onClick={(event) => {
                event.preventDefault();
                void confirmUndo();
              }}
            >
              {undoing ? "Undoing…" : "Undo Commit"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});

/** 将提交引用按 Git 类别渲染，避免本地与远端跟踪分支混为同一种标签。 */
function GitRefBadge({
  ref,
  iconOnly = false,
}: {
  ref: GitLogEntry["refs"][number];
  iconOnly?: boolean;
}) {
  const appearance =
    ref.kind === "remote"
      ? {
          icon: CloudIcon,
          iconClassName: "scale-[1.2]",
          className:
            "border-violet-500 bg-violet-500 text-white dark:text-black",
        }
      : ref.kind === "tag"
        ? {
            icon: Tag01Icon,
            className:
              "border-amber-600 bg-amber-600 text-white dark:text-black",
          }
        : {
            icon: GitBranchIcon,
            iconClassName: "scale-[1.2]",
            className: "border-blue-500 bg-blue-500 text-white dark:text-black",
          };

  return (
    <span
      className={cn(
        "ml-1 inline-flex h-5 max-w-28 shrink-0 items-center gap-1 truncate rounded border px-1.5 text-[11px] font-medium",
        appearance.className,
      )}
    >
      <HugeiconsIcon
        icon={appearance.icon}
        size={13}
        strokeWidth={1.8}
        className={cn("shrink-0", appearance.iconClassName)}
      />
      {iconOnly ? (
        <span className="sr-only">{ref.label}</span>
      ) : (
        <span className="truncate">{ref.label}</span>
      )}
    </span>
  );
}

function GraphPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-20 flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-muted-foreground">
      {children}
    </div>
  );
}
