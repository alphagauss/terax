import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { type GitLogEntry, native } from "@/modules/ai/lib/native";
import {
  CommitDetail,
  type CommitDetailFilesEntry,
} from "@/modules/git-history/CommitDetail";
import { GraphRail } from "@/modules/git-history/GraphRail";
import { layoutGraph } from "@/modules/git-history/lib/graph";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

const PAGE_SIZE = 40;
const ROW_HEIGHT = 24;
const NEAR_BOTTOM_PX = 180;
const FILES_CACHE_LIMIT = 16;

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
  headSha: string | null;
  expanded: boolean;
  refreshToken: number;
  showUndoCommit: boolean;
  mayHavePushedHead: boolean;
  onDidUndo: () => void;
  onOpenCommitFile?: (input: CommitFileDiffOpenInput) => void;
};

type LoadStatus = "idle" | "initial" | "more" | "initial-error" | "more-error";
type FilesEntry = CommitDetailFilesEntry;
type Anchor = {
  sha: string;
  top: number;
  left: number;
  width: number;
  height: number;
};

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown Git error";
}

function relativeTime(timestampSecs: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - timestampSecs);
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d`;
  if (delta < 86400 * 365) return `${Math.floor(delta / (86400 * 30))}mo`;
  return `${Math.floor(delta / (86400 * 365))}y`;
}

function refLabel(value: string): string {
  return value.replace(/^HEAD -> /, "").replace(/^tag: /, "");
}

function withFilesEntry(
  current: Map<string, FilesEntry>,
  sha: string,
  entry: FilesEntry,
): Map<string, FilesEntry> {
  const next = new Map(current);
  next.delete(sha);
  next.set(sha, entry);
  while (next.size > FILES_CACHE_LIMIT) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

export const GraphSection = memo(function GraphSection({
  repoRoot,
  headSha,
  expanded,
  refreshToken,
  showUndoCommit,
  mayHavePushedHead,
  onDidUndo,
  onOpenCommitFile,
}: Props) {
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [endReached, setEndReached] = useState(false);
  const [openAnchor, setOpenAnchor] = useState<Anchor | null>(null);
  const [filesBySha, setFilesBySha] = useState<Map<string, FilesEntry>>(
    () => new Map(),
  );
  const [pendingUndo, setPendingUndo] = useState<GitLogEntry | null>(null);
  const [undoing, setUndoing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const filesInflightRef = useRef(new Set<string>());
  const openSequenceRef = useRef(0);
  const refreshKey = repoRoot
    ? `${repoRoot}:${headSha ?? ""}:${refreshToken}`
    : null;

  const loadInitial = useCallback(async () => {
    if (!repoRoot || !expanded) return;
    const request = ++requestRef.current;
    loadingMoreRef.current = false;
    filesInflightRef.current.clear();
    setLoadStatus("initial");
    setError(null);
    setEndReached(false);
    openSequenceRef.current += 1;
    setOpenAnchor(null);
    setFilesBySha(new Map());
    try {
      const next = await native.gitLog(repoRoot, { limit: PAGE_SIZE });
      if (request !== requestRef.current) return;
      setCommits(next);
      setEndReached(next.length < PAGE_SIZE);
      setLoadStatus("idle");
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 }));
    } catch (loadError) {
      if (request !== requestRef.current) return;
      setError(normalizeError(loadError));
      setLoadStatus("initial-error");
    }
  }, [expanded, repoRoot]);

  useEffect(() => {
    if (!expanded || !refreshKey) return;
    void loadInitial();
  }, [expanded, loadInitial, refreshKey]);

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
    const cursor = commits[commits.length - 1]?.sha;
    if (!cursor) return;
    const request = requestRef.current;
    loadingMoreRef.current = true;
    setLoadStatus("more");
    setError(null);
    try {
      const next = await native.gitLog(repoRoot, {
        limit: PAGE_SIZE,
        beforeSha: cursor,
      });
      if (request !== requestRef.current) return;
      setCommits((current) => {
        const known = new Set(current.map((commit) => commit.sha));
        return current.concat(next.filter((commit) => !known.has(commit.sha)));
      });
      setEndReached(next.length < PAGE_SIZE);
      setLoadStatus("idle");
    } catch (loadError) {
      if (request !== requestRef.current) return;
      setError(normalizeError(loadError));
      setLoadStatus("more-error");
    } finally {
      if (request === requestRef.current) loadingMoreRef.current = false;
    }
  }, [commits, endReached, expanded, loadStatus, repoRoot]);

  const { rows: graphRows } = useMemo(() => layoutGraph(commits), [commits]);
  const graphBySha = useMemo(
    () => new Map(graphRows.map((row) => [row.sha, row])),
    [graphRows],
  );
  const maxLaneCount = useMemo(
    () => Math.max(1, ...graphRows.map((row) => row.laneCount)),
    [graphRows],
  );

  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => commits[index]?.sha ?? index,
  });

  useEffect(() => {
    if (!expanded || loadStatus !== "idle" || endReached) return;
    const scroll = scrollRef.current;
    if (scroll && scroll.scrollHeight <= scroll.clientHeight + NEAR_BOTTOM_PX) {
      void loadMore();
    }
  }, [endReached, expanded, loadMore, loadStatus]);

  const fetchFiles = useCallback(
    async (sha: string) => {
      if (!repoRoot || filesInflightRef.current.has(sha)) return;
      const request = requestRef.current;
      filesInflightRef.current.add(sha);
      setFilesBySha((current) =>
        withFilesEntry(current, sha, { state: "loading" }),
      );
      try {
        const [files, message] = await Promise.all([
          native.gitCommitFiles(repoRoot, sha),
          native.gitCommitMessage(repoRoot, sha),
        ]);
        if (request !== requestRef.current) return;
        setFilesBySha((current) =>
          withFilesEntry(current, sha, {
            state: "loaded",
            files,
            message,
          }),
        );
      } catch (filesError) {
        if (request !== requestRef.current) return;
        setFilesBySha((current) =>
          withFilesEntry(current, sha, {
            state: "error",
            error: normalizeError(filesError),
          }),
        );
      } finally {
        if (request === requestRef.current) {
          filesInflightRef.current.delete(sha);
        }
      }
    },
    [repoRoot],
  );

  const closePopover = useCallback(() => {
    openSequenceRef.current += 1;
    setOpenAnchor(null);
  }, []);

  const openCommit = useCallback(
    (commit: GitLogEntry, element: HTMLElement) => {
      if (openAnchor?.sha === commit.sha) {
        closePopover();
        return;
      }
      const rect = element.getBoundingClientRect();
      const nextAnchor = {
        sha: commit.sha,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
      const sequence = ++openSequenceRef.current;
      setOpenAnchor(null);
      window.setTimeout(() => {
        if (sequence === openSequenceRef.current) setOpenAnchor(nextAnchor);
      }, 0);
      if (!filesBySha.has(commit.sha)) void fetchFiles(commit.sha);
    },
    [closePopover, fetchFiles, filesBySha, openAnchor?.sha],
  );

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
      toast.error("Could not undo commit", {
        description: normalizeError(undoError),
      });
    } finally {
      setUndoing(false);
    }
  }, [closePopover, onDidUndo, pendingUndo, repoRoot]);

  const selectedCommit = openAnchor
    ? (commits.find((commit) => commit.sha === openAnchor.sha) ?? null)
    : null;
  const selectedFiles = selectedCommit
    ? (filesBySha.get(selectedCommit.sha) ?? null)
    : null;

  if (!repoRoot) {
    return <GraphPlaceholder>No Git repository.</GraphPlaceholder>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar [contain:layout_style]">
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
        <div
          ref={scrollRef}
          onScroll={(event) => {
            if (openAnchor) closePopover();
            const target = event.currentTarget;
            if (
              target.scrollHeight - target.scrollTop - target.clientHeight <
              NEAR_BOTTOM_PX
            ) {
              void loadMore();
            }
          }}
          className="app-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const commit = commits[virtualRow.index];
              const graphRow = commit ? graphBySha.get(commit.sha) : null;
              if (!commit || !graphRow) return null;
              const refs = commit.refs.map(refLabel).slice(0, 2);
              return (
                <button
                  key={virtualRow.key}
                  type="button"
                  onClick={(event) => openCommit(commit, event.currentTarget)}
                  title={`${commit.shortSha} ${commit.subject}`}
                  className={cn(
                    "group absolute left-0 flex w-full cursor-pointer items-center pr-2 text-left transition-colors hover:bg-accent/35",
                    openAnchor?.sha === commit.sha && "bg-accent/55",
                  )}
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <GraphRail
                    row={graphRow}
                    rowHeight={ROW_HEIGHT}
                    maxLaneCount={maxLaneCount}
                    active={openAnchor?.sha === commit.sha}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/90">
                    {commit.subject || "(no subject)"}
                  </span>
                  {refs.map((value) => (
                    <span
                      key={value}
                      className="ml-1 max-w-20 shrink-0 truncate rounded border border-primary/25 bg-primary/10 px-1 py-px text-[9px] font-medium text-primary"
                    >
                      {value}
                    </span>
                  ))}
                  <span className="ml-1.5 w-6 shrink-0 text-right font-mono text-[9.5px] tabular-nums text-muted-foreground/70">
                    {relativeTime(commit.timestampSecs)}
                  </span>
                </button>
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

      <Popover
        open={!!openAnchor}
        onOpenChange={(next) => {
          if (!next) closePopover();
        }}
      >
        {typeof document !== "undefined"
          ? createPortal(
              <PopoverAnchor asChild>
                <div
                  aria-hidden
                  style={{
                    position: "fixed",
                    top: openAnchor?.top ?? -9999,
                    left: openAnchor?.left ?? -9999,
                    width: openAnchor?.width ?? 0,
                    height: openAnchor?.height ?? 0,
                    pointerEvents: "none",
                  }}
                />
              </PopoverAnchor>,
              document.body,
            )
          : null}
        <PopoverContent
          side="right"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          avoidCollisions
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="flex w-[390px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-lg p-0 shadow-xl"
        >
          {selectedCommit ? (
            <CommitDetail
              key={selectedCommit.sha}
              commit={selectedCommit}
              filesEntry={selectedFiles}
              onUndo={
                showUndoCommit &&
                selectedCommit.sha === headSha &&
                selectedCommit.parents.length > 0
                  ? () => setPendingUndo(selectedCommit)
                  : undefined
              }
              onRetry={() => void fetchFiles(selectedCommit.sha)}
              onOpenFile={(file) => {
                if (!onOpenCommitFile) return;
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
        </PopoverContent>
      </Popover>

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

function GraphPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-20 flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-muted-foreground">
      {children}
    </div>
  );
}
