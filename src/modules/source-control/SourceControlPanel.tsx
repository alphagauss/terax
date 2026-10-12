/**
 * 本文件实现 Source Control 面板及其仓库、变更和提交操作界面。
 * 密集的文件路径与状态信息需在明暗主题下保持清晰可读。
 * Changes 使用普通文档流，侧栏切换保留展示树；open 控制面板手动刷新和 Graph 活动、展示，
 * 不停止共享仓库控制器的数据更新。
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
import { AnimatedDiffStats } from "@/components/controls/animated-diff-stats";
import { ContentReveal } from "@/components/controls/content-reveal";
import { Button } from "@/components/controls/button";
import { Textarea } from "@/components/controls/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/controls/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/menu/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { IS_MAC } from "@/lib/platform";
import { scrollListRowIntoView } from "@/lib/scrollIntoView";
import { cn } from "@/lib/utils";
import { type GitBranchEntry, native } from "@/modules/ai/lib/native";
import {
  copyToClipboard,
  revealInFinder,
} from "@/modules/explorer/lib/contextActions";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { joinPath } from "@/modules/explorer/lib/useFileTree";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { SidebarSectionAction, SidebarSectionGroup } from "@/modules/sidebar";
import { GraphSection } from "@/modules/source-control/GraphSection";
import type { GitDiffSide } from "@/modules/source-control/gitTypes";
import { relativeTime } from "@/modules/source-control/relativeTime";
import type { RepositoryController } from "@/modules/source-control/useRepositoryController";
import {
  type SourceControlFileEntry,
  useSourceControlPanel,
} from "@/modules/source-control/useSourceControlPanel";
import {
  Add01Icon,
  AiContentGenerator02Icon,
  Alert02Icon,
  ArrowDown01Icon,
  ArrowTurnBackwardIcon,
  ArrowUp01Icon,
  CheckmarkCircle01Icon,
  Download01Icon,
  FileEditIcon,
  Folder01Icon,
  FolderCloudIcon,
  FolderGitTwoIcon,
  MinusSignIcon,
  Refresh01Icon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { reportError } from "@/lib/errors";
import { RepositoryDiffStats } from "./RepositoryDiffStats";

type Props = {
  open: boolean;
  sourceControl: RepositoryController;
  onOpenCommitFile?: (input: {
    repoRoot: string;
    sha: string;
    shortSha: string;
    subject: string;
    path: string;
    originalPath: string | null;
  }) => void;
  onOpenDiff: (input: {
    path: string;
    repoRoot: string;
    side: GitDiffSide;
    originalPath: string | null;
    title?: string;
  }) => void;
  onOpenFile?: (absolutePath: string) => void;
  onNavigateToPath?: (path: string) => void;
};

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "";
  return normalized.slice(0, index);
}

function entryPathLabel(entry: SourceControlFileEntry): string {
  if (entry.originalPath) return `${entry.originalPath} → ${entry.path}`;
  return dirname(entry.path);
}

function upstreamBadgeLabel(
  upstream: string | null | undefined,
  noUpstreamLabel: string,
): string {
  if (!upstream) return noUpstreamLabel;
  return upstream;
}

function statusAccent(code: string): string {
  switch (code) {
    case "A":
      return "bg-success";
    case "U":
      return "bg-teal-500/85";
    case "M":
      return "bg-warning";
    case "D":
      return "bg-destructive";
    case "R":
      return "bg-info";
    default:
      return "bg-muted-foreground/40";
  }
}

function BranchDropdown({
  repoRoot,
  repoLabel,
  onNavigateToPath,
  onRefresh,
}: {
  repoRoot: string | null;
  repoLabel: string;
  onNavigateToPath?: (path: string) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation("sourceControl");
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const requestRef = useRef(0);
  const checkoutInFlight = useRef(false);

  const loadBranches = useCallback(async () => {
    const id = ++requestRef.current;
    if (!repoRoot) {
      setBranches([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await native.gitListBranches(repoRoot);
      if (id !== requestRef.current) return;
      setBranches(result.branches);
    } catch (e) {
      if (id !== requestRef.current) return;
      setError(String(e));
      setBranches([]);
    } finally {
      if (id === requestRef.current) {
        setLoading(false);
      }
    }
  }, [repoRoot]);

  useEffect(() => {
    if (open) {
      void loadBranches();
    }
  }, [open, loadBranches]);

  const handleCheckout = useCallback(
    async (branch: GitBranchEntry, trackRemote = false) => {
      if (!repoRoot || checkoutInFlight.current) return;
      checkoutInFlight.current = true;
      setCheckingOut(true);
      try {
        await native.gitCheckoutBranch(repoRoot, branch.name, trackRemote);
        setBranches([]);
        setOpen(false);
        onRefresh();
      } catch (e) {
        reportError(String(e), { error: e });
      } finally {
        checkoutInFlight.current = false;
        setCheckingOut(false);
      }
    },
    [repoRoot, onRefresh],
  );

  const localBranches = useMemo(
    () => branches.filter((b) => b.kind === "local"),
    [branches],
  );
  const worktrees = useMemo(
    () => branches.filter((b) => b.kind === "worktree"),
    [branches],
  );
  const remoteBranches = useMemo(
    () => branches.filter((b) => b.kind === "remote"),
    [branches],
  );

  const checkoutTarget = useCallback(
    (branch: GitBranchEntry) => {
      if (branch.kind !== "remote") {
        void handleCheckout(branch);
        return;
      }
      const localName = branch.name.split("/").slice(1).join("/");
      const localBranch = localBranches.find(
        (local) => local.name === localName,
      );
      void handleCheckout(localBranch ?? branch, !localBranch);
    },
    [handleCheckout, localBranches],
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={checkingOut}
          className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-interactive-hover px-2 py-1 text-[11.5px] font-medium leading-none text-foreground transition-colors hover:bg-interactive-active disabled:cursor-default disabled:opacity-70"
        >
          <HugeiconsIcon
            icon={FolderGitTwoIcon}
            size={12}
            strokeWidth={1.9}
            className="shrink-0 text-muted-foreground"
          />
          <span className="max-w-35 truncate">{repoLabel}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            {t("branch.loading")}
          </div>
        ) : error ? (
          <div className="px-3 py-3 text-[11px] leading-snug text-destructive">
            {error}
          </div>
        ) : (
          <>
            {localBranches.length > 0 && (
              <>
                <DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t("branch.localBranches")}
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {localBranches.map((b) => (
                    <DropdownMenuItem
                      key={b.name}
                      onSelect={() => checkoutTarget(b)}
                      className="flex cursor-pointer items-center gap-2 text-[12px]"
                    >
                      {b.isHead ? (
                        <HugeiconsIcon
                          icon={Tick02Icon}
                          size={14}
                          strokeWidth={1.8}
                          className="shrink-0"
                        />
                      ) : (
                        <span className="w-3.5 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      <BranchTimestamp timestampSecs={b.timestampSecs} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            {remoteBranches.length > 0 && (
              <>
                {localBranches.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t("branch.remoteBranches")}
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {remoteBranches.map((b) => (
                    <DropdownMenuItem
                      key={b.name}
                      onSelect={() => checkoutTarget(b)}
                      className="flex cursor-pointer items-center gap-2 text-[12px]"
                    >
                      <HugeiconsIcon
                        icon={FolderCloudIcon}
                        size={14}
                        strokeWidth={1.5}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      <BranchTimestamp timestampSecs={b.timestampSecs} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            {worktrees.length > 0 && (
              <>
                {(localBranches.length > 0 || remoteBranches.length > 0) && (
                  <DropdownMenuSeparator />
                )}
                <DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t("branch.worktrees")}
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {worktrees.map((b) => (
                    <DropdownMenuItem
                      key={b.worktreePath ?? b.name}
                      onSelect={() => {
                        if (b.worktreePath && onNavigateToPath) {
                          onNavigateToPath(b.worktreePath);
                        }
                      }}
                      className="flex cursor-pointer items-center gap-2 text-[12px]"
                    >
                      <HugeiconsIcon
                        icon={Folder01Icon}
                        size={14}
                        strokeWidth={1.5}
                        className="shrink-0 text-muted-foreground"
                      />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{b.name}</span>
                        {b.worktreePath && (
                          <span className="truncate text-[10px] text-muted-foreground">
                            {b.worktreePath}
                          </span>
                        )}
                      </div>
                      <BranchTimestamp timestampSecs={b.timestampSecs} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            {branches.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-muted-foreground">
                {t("branch.noBranches")}
              </div>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BranchTimestamp({ timestampSecs }: { timestampSecs: number | null }) {
  return (
    <span className="w-7 shrink-0 text-right font-mono text-[9.5px] tabular-nums text-muted-foreground">
      {timestampSecs === null ? "" : relativeTime(timestampSecs)}
    </span>
  );
}

function SourceControlViewContainerComponent({
  open,
  sourceControl,
  onOpenCommitFile,
  onOpenDiff,
  onOpenFile,
  onNavigateToPath,
}: Props) {
  const { t } = useTranslation("sourceControl");
  const scm = useSourceControlPanel(open, sourceControl, onOpenDiff);
  const refreshAnimationRef = useRef<number | null>(null);
  const [refreshAnimating, setRefreshAnimating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [collapsedGroups, setCollapsedGroups] = useState({
    index: false,
    worktree: false,
  });
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [graphRefreshToken, setGraphRefreshToken] = useState(0);
  const [graphSearchOpen, setGraphSearchOpen] = useState(false);
  const showUndoCommit = usePreferencesStore(
    (state) => state.sourceControlShowUndoCommit,
  );
  const refreshSourceControl = scm.refresh;

  useEffect(() => {
    return () => {
      if (refreshAnimationRef.current) {
        window.clearTimeout(refreshAnimationRef.current);
      }
    };
  }, []);

  const isRefreshing = scm.panelState === "loading";
  const repoLabel = useMemo(() => {
    if (!scm.status) return t("sourceControl");
    return scm.status.isDetached ? t("detached") : scm.status.branch;
  }, [scm.status, t]);

  const commitShortcut = IS_MAC ? "⌘↩" : "Ctrl+Enter";
  const generateShortcut = IS_MAC ? "⌘G" : "Ctrl+G";
  const canCommit =
    scm.stagedEntries.length > 0 &&
    scm.commitMessage.trim().length > 0 &&
    !scm.actionBusy;
  const commitDisabledReason = scm.actionBusy
    ? t("commit.waitForAction")
    : scm.stagedEntries.length === 0
      ? t("commit.stageToEnable")
      : scm.commitMessage.trim().length === 0
        ? t("commit.enterMessage")
        : null;
  const commitHint = canCommit
    ? t("commit.hint", { shortcut: commitShortcut })
    : (commitDisabledReason ?? t("commit.hint", { shortcut: commitShortcut }));
  const pushHint = scm.pushHint ?? t("push.unavailable");
  const pushDisabledReason = scm.actionBusy
    ? t("commit.waitForAction")
    : pushHint;
  const stagedCount = scm.stagedEntries.length;
  const changedCount = sourceControl.changedCount;
  const pushStatusLabel = upstreamBadgeLabel(
    scm.status?.upstream,
    t("noUpstream"),
  );
  const hasUpstream = !!scm.status?.upstream;
  const isDiverged =
    !!scm.status && scm.status.ahead > 0 && scm.status.behind > 0;

  const canPull =
    hasUpstream &&
    !!scm.status &&
    scm.status.behind > 0 &&
    !isDiverged &&
    !scm.actionBusy &&
    !sourceControl.busyAction;
  const canFetch = hasUpstream && !scm.actionBusy && !sourceControl.busyAction;

  const footerFeedback = useMemo(() => {
    if (scm.actionError)
      return { tone: "error", message: scm.actionError } as const;
    if (scm.remoteError)
      return { tone: "error", message: scm.remoteError } as const;
    if (scm.actionMessage)
      return { tone: "success", message: scm.actionMessage } as const;
    return null;
  }, [scm.actionError, scm.actionMessage, scm.remoteError]);

  const handleCommitShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      canCommit
    ) {
      event.preventDefault();
      void scm.commit();
      return;
    }
    if (
      event.key.toLowerCase() === "g" &&
      (event.metaKey || event.ctrlKey) &&
      scm.canGenerateCommitMessage
    ) {
      event.preventDefault();
      void scm.generateCommitMessage();
    }
  };

  const handleRefresh = useCallback(() => {
    setRefreshAnimating(true);
    if (refreshAnimationRef.current) {
      window.clearTimeout(refreshAnimationRef.current);
    }
    void refreshSourceControl().finally(() => {
      refreshAnimationRef.current = window.setTimeout(() => {
        setRefreshAnimating(false);
        refreshAnimationRef.current = null;
      }, 450);
    });
  }, [refreshSourceControl]);

  const handleFetch = useCallback(async () => {
    await sourceControl.runRemoteAction("fetch");
  }, [sourceControl]);

  const handlePull = useCallback(() => {
    void sourceControl.runRemoteAction("pull");
  }, [sourceControl]);

  const groups = useMemo(
    () =>
      (["index", "worktree"] as const)
        .map((side) => ({
          side,
          entries: scm.fileEntries.filter((entry) => entry.side === side),
        }))
        .filter((group) => group.entries.length > 0),
    [scm.fileEntries],
  );
  const rows = useMemo(
    () =>
      groups.flatMap(({ side, entries }) =>
        collapsedGroups[side] ? [] : entries,
      ),
    [groups, collapsedGroups],
  );

  const rowKeyToIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((entry, index) => {
      map.set(entry.key, index);
    });
    return map;
  }, [rows]);

  useEffect(() => {
    if (!focusedRowKey) return;
    if (!rowKeyToIndex.has(focusedRowKey)) {
      setFocusedRowKey(null);
    }
  }, [focusedRowKey, rowKeyToIndex]);

  const moveFocus = useCallback(
    (direction: 1 | -1) => {
      const currentIndex =
        focusedRowKey === null ? -1 : (rowKeyToIndex.get(focusedRowKey) ?? -1);
      const position =
        currentIndex < 0 ? (direction > 0 ? -1 : rows.length) : currentIndex;
      const target =
        rows[Math.max(0, Math.min(rows.length - 1, position + direction))];
      if (!target) return;
      setFocusedRowKey(target.key);
      scrollListRowIntoView(
        scrollRef.current,
        `scm-row-${target.key}`,
        scrollRef.current?.querySelector<HTMLElement>("[data-scm-group]")
          ?.offsetHeight ?? 0,
      );
    },
    [focusedRowKey, rowKeyToIndex, rows],
  );

  const focusedEntry = useCallback((): SourceControlFileEntry | null => {
    if (!focusedRowKey) return null;
    const index = rowKeyToIndex.get(focusedRowKey);
    if (index === undefined) return null;
    return rows[index] ?? null;
  }, [focusedRowKey, rowKeyToIndex, rows]);

  const handlePanelKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.closest("button"))
      ) {
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (meta && (event.key === "r" || event.key === "R")) {
        event.preventDefault();
        handleRefresh();
        return;
      }
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveFocus(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          moveFocus(-1);
          break;
        case "Enter": {
          const entry = focusedEntry();
          if (entry) {
            event.preventDefault();
            scm.openFileDiff(entry);
          }
          break;
        }
        case " ":
        case "s":
        case "S": {
          if (meta || scm.actionBusy !== null) break;
          const entry = focusedEntry();
          if (entry) {
            event.preventDefault();
            void scm.toggleStageFile(entry);
          }
          break;
        }
        case "d":
        case "D": {
          if (meta || scm.actionBusy !== null) break;
          const entry = focusedEntry();
          if (entry?.side === "worktree") {
            event.preventDefault();
            scm.requestDiscardFile(entry);
          }
          break;
        }
      }
    },
    [focusedEntry, handleRefresh, moveFocus, scm],
  );

  const fetchBusy = sourceControl.busyAction === "fetch";
  const pullBusy = sourceControl.busyAction === "pull";

  return (
    <TooltipProvider>
      <aside className="flex h-full min-w-0 flex-col bg-sidebar [contain:layout_style]">
        <SidebarSectionGroup
          id="source-control"
          sections={[
            {
              id: "changes",
              title: "Changes",
              badge: scm.status ? changedCount : undefined,
              description: repoLabel,
              defaultSize: 430,
              minSize: 180,
              actions: (
                <>
                  <IconActionButton
                    label={t(fetchBusy ? "fetch.fetching" : "fetch.label")}
                    disabled={!canFetch}
                    onClick={handleFetch}
                    side="bottom"
                  >
                    {fetchBusy ? (
                      <Spinner className="size-3" />
                    ) : (
                      <HugeiconsIcon
                        icon={FolderCloudIcon}
                        size={13}
                        strokeWidth={1.85}
                      />
                    )}
                  </IconActionButton>
                  <IconActionButton
                    label={
                      pullBusy
                        ? t("pull.pulling")
                        : isDiverged
                          ? t("pull.diverged")
                          : !hasUpstream
                            ? t("pull.noUpstream")
                            : (scm.status?.behind ?? 0) === 0
                              ? t("pull.upToDate")
                              : t("pull.commits", {
                                  count: scm.status?.behind ?? 0,
                                })
                    }
                    disabled={!canPull}
                    onClick={handlePull}
                    side="bottom"
                  >
                    {pullBusy ? (
                      <Spinner className="size-3" />
                    ) : (
                      <HugeiconsIcon
                        icon={Download01Icon}
                        size={13}
                        strokeWidth={1.9}
                      />
                    )}
                  </IconActionButton>
                  <IconActionButton
                    label={t("refresh")}
                    disabled={isRefreshing || !!scm.actionBusy}
                    onClick={handleRefresh}
                    side="bottom"
                  >
                    {isRefreshing ? (
                      <Spinner className="size-3" />
                    ) : (
                      <HugeiconsIcon
                        icon={Refresh01Icon}
                        size={13}
                        strokeWidth={1.9}
                        className={cn(refreshAnimating && "animate-spin")}
                      />
                    )}
                  </IconActionButton>
                </>
              ),
              render: ({ present }) =>
                present ? (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/40 px-2.5">
                      <BranchDropdown
                        repoRoot={scm.repo?.repoRoot ?? null}
                        repoLabel={repoLabel}
                        onNavigateToPath={onNavigateToPath}
                        onRefresh={handleRefresh}
                      />
                      {scm.status &&
                      (scm.status.ahead > 0 || scm.status.behind > 0) ? (
                        <div className="flex shrink-0 items-center gap-0.5 text-[10px] font-semibold tabular-nums leading-none text-muted-foreground">
                          {scm.status.ahead > 0 ? (
                            <span className="inline-flex items-center gap-0.5 rounded-md border border-border/60 px-1 py-0.5">
                              <HugeiconsIcon
                                icon={ArrowUp01Icon}
                                size={9}
                                strokeWidth={2.2}
                              />
                              {scm.status.ahead}
                            </span>
                          ) : null}
                          {scm.status.behind > 0 ? (
                            <span className="inline-flex items-center gap-0.5 rounded-md border border-border/60 px-1 py-0.5">
                              <HugeiconsIcon
                                icon={ArrowDown01Icon}
                                size={9}
                                strokeWidth={2.2}
                              />
                              {scm.status.behind}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {scm.repo && (
                        <RepositoryDiffStats
                          key={scm.repo.repoRoot}
                          stats={scm.diffStats}
                        />
                      )}
                      {scm.status?.isDetached ? (
                        <span className="rounded bg-muted/55 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground">
                          detached
                        </span>
                      ) : null}
                    </div>

                    {scm.panelState === "loading" ? (
                      <PanelCenter title="Loading repository" />
                    ) : null}

                    {scm.panelState === "no-repo" ? (
                      <PanelCenter
                        title="No repository"
                        body="The active workspace is not inside a Git repository."
                      />
                    ) : null}

                    {scm.panelState === "error" ? (
                      <PanelCenter
                        title="Source control error"
                        body={scm.statusError ?? "Unknown source control error"}
                        action={
                          <Button size="sm" onClick={() => void scm.refresh()}>
                            Retry
                          </Button>
                        }
                      />
                    ) : null}

                    {scm.panelState === "ready" && scm.status ? (
                      <>
                        <div className="relative shrink-0 space-y-2 border-b border-border/40 bg-gradient-to-b from-card/65 to-card/30 px-2.5 pb-2.5 pt-2.5">
                          <div
                            className={cn(
                              "relative rounded-lg border bg-background/95 shadow-sm transition-colors",
                              scm.commitMessage.length > 0
                                ? "border-border/70"
                                : "border-border/45",
                              "focus-within:border-primary/45 focus-within:shadow-md focus-within:shadow-primary/5",
                            )}
                          >
                            <Textarea
                              value={scm.commitMessage}
                              onChange={(event) =>
                                scm.setCommitMessage(event.target.value)
                              }
                              onKeyDown={handleCommitShortcut}
                              placeholder={t("commit.placeholder", {
                                shortcut: commitShortcut,
                              })}
                              rows={1}
                              className="min-h-0 border-border resize-none bg-transparent pr-9 shadow-none"
                            />
                            <div className="absolute right-1 top-1">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    aria-label={`${scm.generateCommitMessageHint} (${generateShortcut})`}
                                    disabled={!scm.canGenerateCommitMessage}
                                    onClick={() =>
                                      void scm.generateCommitMessage()
                                    }
                                    className={cn(
                                      "inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors",
                                      "hover:bg-interactive-hover hover:text-foreground",
                                      "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
                                    )}
                                  >
                                    {scm.actionBusy === "generate-message" ? (
                                      <Spinner className="size-3" />
                                    ) : (
                                      <HugeiconsIcon
                                        icon={AiContentGenerator02Icon}
                                        size={14}
                                        strokeWidth={1.75}
                                      />
                                    )}
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="left">
                                  {`${scm.generateCommitMessageHint} (${generateShortcut})`}
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          </div>

                          <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
                            <span
                              className={cn(
                                "size-1.5 shrink-0 rounded-full transition-colors",
                                canCommit
                                  ? "bg-foreground/80"
                                  : stagedCount > 0
                                    ? "bg-muted-foreground/60"
                                    : "bg-muted-foreground/30",
                              )}
                            />
                            <span className="truncate font-medium text-foreground">
                              {stagedCount === 0
                                ? "Nothing staged"
                                : `${stagedCount} ${stagedCount === 1 ? "file" : "files"} staged`}
                            </span>
                            <span className="ml-auto shrink-0 truncate text-muted-foreground">
                              {pushStatusLabel}
                            </span>
                          </div>

                          <div className="grid w-full grid-cols-2 gap-1.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="sm"
                                  className="cursor-pointer font-semibold tracking-tight shadow-sm disabled:cursor-not-allowed disabled:shadow-none"
                                  disabled={!canCommit}
                                  onClick={() => void scm.commit()}
                                >
                                  {scm.actionBusy === "commit"
                                    ? "Committing…"
                                    : "Commit"}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom">
                                {commitHint}
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="cursor-pointer font-medium disabled:cursor-not-allowed"
                                  disabled={!scm.canPush || !!scm.actionBusy}
                                  onClick={() => void scm.push()}
                                >
                                  {scm.actionBusy === "push"
                                    ? "Pushing…"
                                    : "Push"}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent
                                side="bottom"
                                className="max-w-64"
                              >
                                {pushDisabledReason}
                              </TooltipContent>
                            </Tooltip>
                          </div>

                          <CommitFeedback feedback={footerFeedback} />
                        </div>

                        {scm.allClean ? (
                          <CleanTreeHint repoLabel={repoLabel} />
                        ) : (
                          <div
                            ref={containerRef}
                            tabIndex={0}
                            role="listbox"
                            aria-label="Changed files"
                            aria-activedescendant={
                              focusedRowKey
                                ? `scm-row-${focusedRowKey}`
                                : undefined
                            }
                            onKeyDown={handlePanelKeyDown}
                            className="relative min-h-0 flex-1 outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                          >
                            <div
                              ref={scrollRef}
                              data-reveal-boundary
                              className="app-scrollbar h-full overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
                            >
                              {isDiverged && <DivergedBanner />}
                              {groups.map(({ side, entries }) => (
                                <div key={side}>
                                  <ListHeader
                                    side={side}
                                    count={entries.length}
                                    expanded={!collapsedGroups[side]}
                                    onToggle={() =>
                                      setCollapsedGroups((current) => ({
                                        ...current,
                                        [side]: !current[side],
                                      }))
                                    }
                                    actionBusy={scm.actionBusy}
                                    onStageAll={scm.stageAllEntries}
                                    onUnstageAll={scm.unstageAllEntries}
                                    onDiscardAll={scm.requestDiscardAll}
                                  />
                                  <ContentReveal
                                    scrollRef={scrollRef}
                                    open={!collapsedGroups[side]}
                                    transitionKey={null}
                                  >
                                    {entries.map((entry) => (
                                      <EntryRow
                                        key={entry.key}
                                        entry={entry}
                                        focused={focusedRowKey === entry.key}
                                        actionBusy={scm.actionBusy}
                                        repoRoot={scm.repo?.repoRoot ?? null}
                                        onFocusRow={setFocusedRowKey}
                                        onOpenFileDiff={scm.openFileDiff}
                                        onToggleStageFile={scm.toggleStageFile}
                                        onDiscardFile={scm.requestDiscardFile}
                                        onOpenFile={onOpenFile}
                                      />
                                    ))}
                                  </ContentReveal>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    ) : null}
                  </div>
                ) : null,
            },
            {
              id: "graph",
              title: "Graph",
              defaultSize: 300,
              minSize: 120,
              actions: ({ expanded, toggle }) => (
                <>
                  <SidebarSectionAction
                    label={t("graph.search")}
                    disabled={!scm.repo}
                    onClick={() => {
                      if (!expanded) toggle();
                      setGraphSearchOpen((current) => !expanded || !current);
                    }}
                  >
                    <HugeiconsIcon
                      icon={Search01Icon}
                      size={13}
                      strokeWidth={1.9}
                    />
                  </SidebarSectionAction>
                  <SidebarSectionAction
                    label={t("graph.refresh")}
                    onClick={() => setGraphRefreshToken((value) => value + 1)}
                  >
                    <HugeiconsIcon
                      icon={Refresh01Icon}
                      size={13}
                      strokeWidth={1.9}
                    />
                  </SidebarSectionAction>
                </>
              ),
              render: ({ expanded, present }) => (
                <GraphSection
                  key={scm.repo?.repoRoot ?? "no-repository"}
                  repoRoot={scm.repo?.repoRoot ?? null}
                  headBranch={scm.status?.branch ?? null}
                  headSha={scm.status?.headSha ?? null}
                  expanded={
                    open && expanded && sourceControl.graphRevision !== null
                  }
                  present={open && present}
                  searchOpen={graphSearchOpen}
                  onCloseSearch={() => setGraphSearchOpen(false)}
                  refreshToken={graphRefreshToken}
                  graphRevision={sourceControl.graphRevision ?? ""}
                  showUndoCommit={showUndoCommit}
                  mayHavePushedHead={
                    !!scm.status?.upstream && (scm.status?.ahead ?? 0) === 0
                  }
                  onDidUndo={handleRefresh}
                  onOpenCommitFile={onOpenCommitFile}
                />
              ),
            },
          ]}
        />
      </aside>

      <AlertDialog
        open={scm.pendingDiscard !== null}
        onOpenChange={(o) => {
          if (!o) scm.cancelPendingDiscard();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("discard.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {scm.pendingDiscard?.scope === "all"
                ? t("discard.descAll", { label: scm.pendingDiscard.label })
                : scm.pendingDiscard
                  ? t("discard.descOne", { label: scm.pendingDiscard.label })
                  : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => scm.cancelPendingDiscard()}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void scm.confirmPendingDiscard()}>
              {t("discard.action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}

/** Source Control 侧边栏容器，渲染仓库状态、文件操作与提交入口。 */
export const SourceControlViewContainer = memo(
  SourceControlViewContainerComponent,
);

function PanelCenter({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-sm font-medium">{title}</div>
      {body ? (
        <div className="max-w-64 text-[11px] leading-relaxed text-muted-foreground">
          {body}
        </div>
      ) : null}
      {action}
    </div>
  );
}

function CleanTreeHint({ repoLabel }: { repoLabel: string }) {
  const { t } = useTranslation("sourceControl");
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center">
      <div className="flex size-8 items-center justify-center rounded-full border border-border/55 text-muted-foreground">
        <HugeiconsIcon
          icon={CheckmarkCircle01Icon}
          size={16}
          strokeWidth={1.6}
        />
      </div>
      <div className="text-[12px] font-medium text-foreground">
        {t("cleanTree")}
      </div>
      <div className="text-[10.5px] leading-snug text-muted-foreground">
        {t("cleanTreeOn")}{" "}
        <span className="font-mono text-foreground">{repoLabel}</span>
      </div>
    </div>
  );
}

type EntryRowProps = {
  entry: SourceControlFileEntry;
  focused: boolean;
  actionBusy: string | null;
  repoRoot: string | null;
  onFocusRow: (key: string | null) => void;
  onOpenFileDiff: (entry: SourceControlFileEntry) => void;
  onToggleStageFile: (entry: SourceControlFileEntry) => Promise<void>;
  onDiscardFile: (entry: SourceControlFileEntry) => void;
  onOpenFile?: (absolutePath: string) => void;
};

function DivergedBanner() {
  const { t } = useTranslation("sourceControl");
  return (
    <div className="mx-2 mt-1 flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-foreground/[0.04] px-2 text-[10.5px] leading-none text-muted-foreground">
      <HugeiconsIcon
        icon={Alert02Icon}
        size={11}
        strokeWidth={1.9}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">
          {t("divergedBanner.title")}
        </span>
        <span className="ml-1">{t("divergedBanner.detail")}</span>
      </span>
    </div>
  );
}

function ListHeader({
  side,
  count,
  expanded,
  onToggle,
  actionBusy,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
}: {
  side: GitDiffSide;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  actionBusy: string | null;
  onStageAll: () => Promise<void>;
  onUnstageAll: () => Promise<void>;
  onDiscardAll: () => void;
}) {
  const { t } = useTranslation("sourceControl");
  const staged = side === "index";
  return (
    <div data-scm-group={side} className="sticky top-0 z-10 bg-sidebar">
      <div className="group flex h-6 items-center gap-1.5 rounded-sm px-2 transition-colors duration-feedback hover:bg-interactive-hover">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded px-0.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-primary/45"
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={12}
            strokeWidth={2.1}
            className={cn(
              "shrink-0 text-muted-foreground transition-transform duration-pane ease-standard motion-reduce:transition-none",
              expanded ? "rotate-0" : "-rotate-90",
            )}
          />
          <span className="min-w-0 truncate text-[13px] font-medium leading-none text-foreground">
            {t(staged ? "groups.staged" : "groups.changes")}
          </span>
          <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-border/60 px-1 text-[9.5px] font-semibold tabular-nums text-muted-foreground">
            {count}
          </span>
        </button>
        <div className="pointer-events-none ml-auto flex shrink-0 items-center opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          {!staged && (
            <IconActionButton
              label={t("groups.discardAll")}
              disabled={actionBusy !== null}
              side="top"
              className="size-5"
              onClick={onDiscardAll}
            >
              <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={13} />
            </IconActionButton>
          )}
          <IconActionButton
            label={t(staged ? "groups.unstageAll" : "groups.stageAll")}
            disabled={actionBusy !== null}
            side="top"
            className="size-5"
            onClick={() => void (staged ? onUnstageAll() : onStageAll())}
          >
            <HugeiconsIcon
              icon={staged ? MinusSignIcon : Add01Icon}
              size={13}
            />
          </IconActionButton>
        </div>
      </div>
    </div>
  );
}

const EntryRow = memo(function EntryRow({
  entry,
  focused,
  actionBusy,
  repoRoot,
  onFocusRow,
  onOpenFileDiff,
  onToggleStageFile,
  onDiscardFile,
  onOpenFile,
}: EntryRowProps) {
  const { t } = useTranslation("sourceControl");
  const fileName = basename(entry.path);
  const iconUrl = fileIconUrl(fileName);
  const pathLabel = entryPathLabel(entry);
  const showDiscard = entry.side === "worktree";
  const isStageBusy =
    actionBusy === `stage:${entry.path}` ||
    actionBusy === `unstage:${entry.path}`;
  const isDiscardBusy = actionBusy === `discard:${entry.path}`;
  const disabled = actionBusy !== null;

  const absolutePath = repoRoot
    ? joinPath(repoRoot.replace(/\\/g, "/"), entry.path.replace(/\\/g, "/"))
    : null;
  const revealLabel = IS_MAC
    ? t("menu.revealInFinder")
    : t("menu.revealInFileManager");

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          id={`scm-row-${entry.key}`}
          data-focused={focused || undefined}
          role="option"
          aria-selected={focused}
          tabIndex={-1}
          onMouseDown={() => onFocusRow(entry.key)}
          className={cn(
            "group relative flex h-6 items-center gap-1.5 rounded-sm px-1.5 transition-colors duration-feedback",
            focused ? "bg-interactive-active" : "hover:bg-interactive-hover",
          )}
        >
          <span
            className={cn(
              "pointer-events-none absolute inset-y-1 left-0 w-[2px] rounded-full transition-opacity",
              statusAccent(entry.statusCode),
              focused ? "opacity-100" : "opacity-55 group-hover:opacity-95",
            )}
            aria-hidden
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  onFocusRow(entry.key);
                  onOpenFileDiff(entry);
                }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
              >
                {iconUrl ? (
                  <img src={iconUrl} alt="" className="size-4 shrink-0" />
                ) : (
                  <span className="size-4 shrink-0" />
                )}
                <div className="flex min-w-0 flex-1 items-baseline gap-1 leading-none">
                  <span
                    className={cn(
                      "truncate text-[13px] leading-none",
                      focused
                        ? "font-semibold text-foreground"
                        : "font-medium text-foreground",
                      "min-w-0 shrink",
                    )}
                  >
                    {fileName}
                  </span>
                  {pathLabel ? (
                    <span className="min-w-0 flex-1 truncate text-[10px] leading-none text-muted-foreground">
                      {pathLabel}
                    </span>
                  ) : null}
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {!entry.lineStats ? (
                t("lineStats.unavailable")
              ) : entry.lineStats.incomplete ? (
                t("lineStats.incomplete")
              ) : entry.lineStats.isBinary ? (
                t("lineStats.binary")
              ) : (
                <AnimatedDiffStats stats={entry.lineStats} animate={false} />
              )}
            </TooltipContent>
          </Tooltip>
          <div className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
            {entry.canOpenFile && onOpenFile && absolutePath && (
              <IconActionButton
                label={t("menu.openFile")}
                disabled={disabled}
                side="top"
                className="size-5"
                onClick={() => onOpenFile(absolutePath)}
              >
                <HugeiconsIcon icon={FileEditIcon} size={13} />
              </IconActionButton>
            )}
            {showDiscard && (
              <IconActionButton
                label={t("menu.discardChanges")}
                disabled={disabled}
                side="top"
                className="size-5"
                onClick={() => onDiscardFile(entry)}
              >
                {isDiscardBusy ? (
                  <Spinner className="size-3" />
                ) : (
                  <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={13} />
                )}
              </IconActionButton>
            )}
            <IconActionButton
              label={t(entry.side === "index" ? "menu.unstage" : "menu.stage")}
              disabled={disabled}
              side="top"
              className="size-5"
              onClick={() => void onToggleStageFile(entry)}
            >
              {isStageBusy ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon
                  icon={entry.side === "index" ? MinusSignIcon : Add01Icon}
                  size={13}
                />
              )}
            </IconActionButton>
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {/* Open actions */}
        <ContextMenuItem
          onSelect={() => {
            onFocusRow(entry.key);
            onOpenFileDiff(entry);
          }}
        >
          {t("menu.openDiff")}
        </ContextMenuItem>
        {entry.canOpenFile && onOpenFile && absolutePath ? (
          <ContextMenuItem onSelect={() => onOpenFile(absolutePath)}>
            {t("menu.openFile")}
          </ContextMenuItem>
        ) : null}

        <ContextMenuSeparator />

        {/* Stage / Unstage */}
        <ContextMenuItem
          disabled={disabled}
          onSelect={() => void onToggleStageFile(entry)}
        >
          {entry.side === "index" ? t("menu.unstage") : t("menu.stage")}
        </ContextMenuItem>
        {entry.side === "worktree" ? (
          <ContextMenuItem
            variant="destructive"
            disabled={disabled}
            onSelect={() => onDiscardFile(entry)}
          >
            {t("menu.discardChanges")}
          </ContextMenuItem>
        ) : null}

        <ContextMenuSeparator />

        {/* Copy paths */}
        <ContextMenuItem
          onSelect={() => void copyToClipboard(entry.path.replace(/\\/g, "/"))}
        >
          {t("menu.copyRelativePath")}
        </ContextMenuItem>
        {absolutePath ? (
          <ContextMenuItem onSelect={() => void copyToClipboard(absolutePath)}>
            {t("menu.copyAbsolutePath")}
          </ContextMenuItem>
        ) : null}

        {/* Reveal in Finder — only for existing files */}
        {entry.canOpenFile && absolutePath ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void revealInFinder(absolutePath)}>
              {revealLabel}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
});

function IconActionButton({
  label,
  disabled,
  side = "left",
  className,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  side?: "left" | "top" | "right" | "bottom";
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className={cn("disabled:cursor-not-allowed", className)}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

function CommitFeedback({
  feedback,
}: {
  feedback: { tone: "error" | "success"; message: string } | null;
}) {
  const [visibleFeedback, setVisibleFeedback] = useState(feedback);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!feedback) {
      setIsVisible(false);
      return;
    }
    setVisibleFeedback(feedback);
    setIsVisible(true);
    const hideTimer = window.setTimeout(() => setIsVisible(false), 3600);
    const clearTimer = window.setTimeout(() => {
      setVisibleFeedback((current) =>
        current?.message === feedback.message && current.tone === feedback.tone
          ? null
          : current,
      );
    }, 3900);
    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer);
    };
  }, [feedback]);

  if (!visibleFeedback) return null;

  const isError = visibleFeedback.tone === "error";
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-3 top-[calc(100%-0.25rem)] z-20 flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug shadow-lg shadow-black/15 backdrop-blur transition-[color,background-color,border-color,opacity,transform] duration-surface",
        isVisible ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
        isError
          ? "border-destructive/30 bg-card/95 text-destructive"
          : "border-border/70 bg-card/95 text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isError ? "bg-destructive" : "bg-foreground/70",
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          isError ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {visibleFeedback.message}
      </span>
    </div>
  );
}
