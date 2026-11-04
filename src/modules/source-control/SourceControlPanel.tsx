/**
 * 本文件实现 Source Control 面板及其仓库、变更和提交操作界面。
 * 密集的文件路径与状态信息需在明暗主题下保持清晰可读。
 * Changes 使用轻量普通行与共享菜单、提示，侧栏切换保留展示树；open 控制展示统计和 Graph，
 * 共享仓库控制器仅为可见消费者校验基础状态，隐藏时停止展示统计。
 */

import { useViewState, useViewScroll } from "@/modules/view-state";
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
  TargetTooltip,
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
import {
  type CommitFileDiffOpenInput,
  type GitBranchEntry,
  native,
} from "@/modules/ai/lib/native";
import {
  copyToClipboard,
  revealInFinder,
} from "@/modules/explorer/lib/contextActions";
import { explorerGitTextClass } from "@/modules/explorer/lib/gitStatusColor";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { joinPath } from "@/modules/explorer/lib/useFileTree";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { SidebarSectionAction, SidebarSectionGroup } from "@/modules/sidebar";
import { GraphSection } from "@/modules/source-control/GraphSection";
import { SourceControlLoading } from "@/modules/source-control/SourceControlLoading";
import type { GitDiffSide } from "@/modules/source-control/gitTypes";
import { relativeTime } from "@/modules/source-control/relativeTime";
import type { RepositoryController } from "@/modules/source-control/useRepositoryController";
import {
  type SourceControlFileEntry,
  useSourceControlPanel,
} from "@/modules/source-control/useSourceControlPanel";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import AiContentGenerator02Icon from "@hugeicons/core-free-icons/AiContentGenerator02Icon";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowTurnBackwardIcon from "@hugeicons/core-free-icons/ArrowTurnBackwardIcon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";
import CheckmarkCircle01Icon from "@hugeicons/core-free-icons/CheckmarkCircle01Icon";
import Download01Icon from "@hugeicons/core-free-icons/Download01Icon";
import FileEditIcon from "@hugeicons/core-free-icons/FileEditIcon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import FolderCloudIcon from "@hugeicons/core-free-icons/FolderCloudIcon";
import FolderGitTwoIcon from "@hugeicons/core-free-icons/FolderGitTwoIcon";
import MinusSignIcon from "@hugeicons/core-free-icons/MinusSignIcon";
import Refresh01Icon from "@hugeicons/core-free-icons/Refresh01Icon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import Tag01Icon from "@hugeicons/core-free-icons/Tag01Icon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  onOpenCommitFile?: (input: CommitFileDiffOpenInput) => void;
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
  const [panelSize, setPanelSize] = useState({ width: 280, height: 800 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const checkoutInFlight = useRef(false);

  useLayoutEffect(() => {
    const panel = triggerRef.current?.closest("aside");
    if (!panel) return;
    const updateSize = () => {
      const { width, height } = panel.getBoundingClientRect();
      if (width > 0 && height > 0) setPanelSize({ width, height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

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

  useLayoutEffect(() => {
    if (!open || loading || branches.length === 0) return;
    const sections = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>(
        "[data-branch-group]",
      ) ?? [],
    );
    // 按真实标题和首行尺寸保留最低高度，工作树的路径行也必须完整可见。
    const updateMinimums = () => {
      for (const section of sections) {
        const label = section.querySelector<HTMLElement>(
          '[data-slot="dropdown-menu-label"]',
        );
        const firstRow =
          section.querySelector<HTMLElement>('[role="menuitem"]');
        if (!label || !firstRow) continue;
        // 布局尺寸不受入场缩放影响，额外 1px 覆盖两次整数取整的误差。
        section.style.minHeight = `${label.offsetHeight + firstRow.offsetHeight + 1}px`;
      }
    };
    updateMinimums();
    const observer = new ResizeObserver(updateMinimums);
    for (const section of sections) {
      const label = section.firstElementChild;
      const firstRow = section.lastElementChild?.firstElementChild;
      if (label) observer.observe(label);
      if (firstRow) observer.observe(firstRow);
    }
    return () => observer.disconnect();
  }, [open, loading, branches]);

  const handleCheckout = useCallback(
    async (branch: GitBranchEntry, trackRemote = false) => {
      if (!repoRoot || checkoutInFlight.current) return;
      checkoutInFlight.current = true;
      setCheckingOut(true);
      try {
        if (branch.kind === "tag") {
          await native.gitCheckoutTag(repoRoot, branch.name);
        } else {
          await native.gitCheckoutBranch(repoRoot, branch.name, trackRemote);
        }
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
  const tags = useMemo(
    () => branches.filter((b) => b.kind === "tag"),
    [branches],
  );
  const popoverMaxHeight = `min(${Math.floor(panelSize.height * 0.8)}px, var(--radix-dropdown-menu-content-available-height))`;

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
          ref={triggerRef}
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
      <DropdownMenuContent
        ref={contentRef}
        align="start"
        className="no-scrollbar flex min-w-0 max-w-(--radix-dropdown-menu-content-available-width) flex-col overflow-x-hidden overflow-y-auto"
        style={{
          width: Math.min(
            360,
            Math.max(240, Math.floor(panelSize.width * 0.9)),
          ),
          maxHeight: popoverMaxHeight,
        }}
      >
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
            {/* 同一高度基准配合内容高度封顶，让短列表的余量由长列表均分。 */}
            {localBranches.length > 0 && (
              <div
                data-branch-group
                className="flex min-h-0 max-h-fit flex-col"
                style={{ flexBasis: popoverMaxHeight }}
              >
                <DropdownMenuLabel className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t("branch.localBranches")}
                </DropdownMenuLabel>
                <DropdownMenuGroup className="no-scrollbar min-h-0 overflow-y-auto overscroll-contain">
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
              </div>
            )}
            {remoteBranches.length > 0 && (
              <>
                {localBranches.length > 0 && (
                  <DropdownMenuSeparator className="shrink-0 bg-border" />
                )}
                <div
                  data-branch-group
                  className="flex min-h-0 max-h-fit flex-col"
                  style={{ flexBasis: popoverMaxHeight }}
                >
                  <DropdownMenuLabel className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t("branch.remoteBranches")}
                  </DropdownMenuLabel>
                  <DropdownMenuGroup className="no-scrollbar min-h-0 overflow-y-auto overscroll-contain">
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
                        <span className="min-w-0 flex-1 truncate">
                          {b.name}
                        </span>
                        <BranchTimestamp timestampSecs={b.timestampSecs} />
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </div>
              </>
            )}
            {tags.length > 0 && (
              <>
                {(localBranches.length > 0 || remoteBranches.length > 0) && (
                  <DropdownMenuSeparator className="shrink-0 bg-border" />
                )}
                <div
                  data-branch-group
                  className="flex min-h-0 max-h-fit flex-col"
                  style={{ flexBasis: popoverMaxHeight }}
                >
                  <DropdownMenuLabel className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t("branch.tags")}
                  </DropdownMenuLabel>
                  <DropdownMenuGroup className="no-scrollbar min-h-0 overflow-y-auto overscroll-contain">
                    {tags.map((tag) => (
                      <DropdownMenuItem
                        key={tag.name}
                        onSelect={() => checkoutTarget(tag)}
                        className="flex cursor-pointer items-center gap-2 text-[12px]"
                      >
                        <HugeiconsIcon
                          icon={Tag01Icon}
                          size={14}
                          strokeWidth={1.5}
                          className="shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {tag.name}
                        </span>
                        <BranchTimestamp timestampSecs={tag.timestampSecs} />
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </div>
              </>
            )}
            {worktrees.length > 0 && (
              <>
                {(localBranches.length > 0 ||
                  remoteBranches.length > 0 ||
                  tags.length > 0) && (
                  <DropdownMenuSeparator className="shrink-0 bg-border" />
                )}
                <div
                  data-branch-group
                  className="flex min-h-0 max-h-fit flex-col"
                  style={{ flexBasis: popoverMaxHeight }}
                >
                  <DropdownMenuLabel className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t("branch.worktrees")}
                  </DropdownMenuLabel>
                  <DropdownMenuGroup className="no-scrollbar min-h-0 overflow-y-auto overscroll-contain">
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
                </div>
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
  const [refreshAnimating, setRefreshAnimating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [collapsedGroups, setCollapsedGroups] = useViewState(
    "collapsedGroups",
    {
      index: false,
      worktree: false,
    },
  );
  const [focusedRowKey, setFocusedRowKey] = useViewState<string | null>(
    "focusedRow",
    null,
  );
  const [contextRowKey, setContextRowKey] = useState<string | null>(null);
  const [hintTarget, setHintTarget] = useState<HTMLElement | null>(null);
  const [hoveredRowKey, setHoveredRowKey] = useState<string | null>(null);
  const clearHover = useCallback(() => {
    setHintTarget(null);
    setHoveredRowKey(null);
  }, []);
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) clearHover();
    };
    window.addEventListener("blur", clearHover);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", clearHover);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [clearHover]);
  useEffect(() => {
    if (!open) clearHover();
  }, [open, clearHover]);
  const [graphRefreshToken, setGraphRefreshToken] = useViewState(
    "graphRefreshToken",
    0,
  );
  const [graphSearchOpen, setGraphSearchOpen] = useViewState(
    "graphSearchOpen",
    false,
  );
  const showUndoCommit = usePreferencesStore(
    (state) => state.sourceControlShowUndoCommit,
  );
  const refreshSourceControl = scm.refresh;

  const isRefreshing = scm.panelState === "loading";
  const graphRepoRoot = scm.repo?.repoRoot ?? null;
  const graphLoading =
    isRefreshing ||
    (graphRepoRoot !== null && sourceControl.graphRevision === null);
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
    void refreshSourceControl().finally(() => {
      setRefreshAnimating(false);
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
  const hintRowKey =
    hintTarget?.closest<HTMLElement>("[data-scm-row-key]")?.dataset.scmRowKey;
  const hintEntry = hintRowKey
    ? (scm.fileEntries.find((entry) => entry.key === hintRowKey) ?? null)
    : null;
  const contextEntry = contextRowKey
    ? (scm.fileEntries.find((entry) => entry.key === contextRowKey) ?? null)
    : null;
  const rows = useMemo(
    () =>
      groups.flatMap(({ side, entries }) =>
        collapsedGroups[side] ? [] : entries,
      ),
    [groups, collapsedGroups],
  );

  const rowKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const attachScroll = useViewScroll("changes", scrollRef, rowKeys, open);

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
      <TargetTooltip target={open && hintEntry ? hintTarget : null}>
        {!hintEntry?.lineStats ? (
          t("lineStats.unavailable")
        ) : hintEntry.lineStats.incomplete ? (
          t("lineStats.incomplete")
        ) : hintEntry.lineStats.isBinary ? (
          t("lineStats.binary")
        ) : (
          <AnimatedDiffStats stats={hintEntry.lineStats} animate={false} />
        )}
      </TargetTooltip>
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
                    disabled={
                      isRefreshing || refreshAnimating || !!scm.actionBusy
                    }
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
                  <div className="relative flex h-full min-h-0 flex-col">
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
                      <SourceControlLoading
                        label={t("panel.loadingChanges")}
                        active={open}
                      />
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

                    {scm.panelState === "ready" && scm.statusError ? (
                      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2 text-[10.5px] text-destructive">
                        <span role="alert" className="min-w-0 flex-1 truncate">
                          {scm.statusError}
                        </span>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={handleRefresh}
                        >
                          {t("panel.retry")}
                        </Button>
                      </div>
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
                            <ContextMenu
                              onOpenChange={(open) => {
                                if (!open) setContextRowKey(null);
                              }}
                            >
                              <ContextMenuTrigger asChild>
                                <div
                                  onContextMenuCapture={(event) => {
                                    const row = (
                                      event.target as HTMLElement
                                    ).closest<HTMLElement>(
                                      "[data-scm-row-key]",
                                    );
                                    const key = row?.dataset.scmRowKey ?? null;
                                    if (!key) {
                                      event.stopPropagation();
                                      return;
                                    }
                                    setContextRowKey(key);
                                    setFocusedRowKey(key);
                                  }}
                                  onPointerMoveCapture={(event) => {
                                    if (event.pointerType !== "mouse") return;
                                    const row = (
                                      event.target as HTMLElement
                                    ).closest<HTMLElement>(
                                      "[data-scm-row-key]",
                                    );
                                    setHoveredRowKey(
                                      row?.dataset.scmRowKey ?? null,
                                    );
                                    const target = (
                                      event.target as HTMLElement
                                    ).closest<HTMLElement>("[data-scm-file]");
                                    setHintTarget(target);
                                  }}
                                  onPointerLeave={clearHover}
                                  onPointerDownCapture={() =>
                                    setHintTarget(null)
                                  }
                                  onScroll={clearHover}
                                  ref={attachScroll}
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
                                            focused={
                                              focusedRowKey === entry.key
                                            }
                                            hovered={
                                              hoveredRowKey === entry.key
                                            }
                                            actionBusy={scm.actionBusy}
                                            repoRoot={
                                              scm.repo?.repoRoot ?? null
                                            }
                                            onFocusRow={setFocusedRowKey}
                                            onOpenFileDiff={scm.openFileDiff}
                                            onToggleStageFile={
                                              scm.toggleStageFile
                                            }
                                            onDiscardFile={
                                              scm.requestDiscardFile
                                            }
                                            onOpenFile={onOpenFile}
                                          />
                                        ))}
                                      </ContentReveal>
                                    </div>
                                  ))}
                                </div>
                              </ContextMenuTrigger>
                              {contextEntry && (
                                <EntryContextMenu
                                  entry={contextEntry}
                                  repoRoot={scm.repo?.repoRoot ?? null}
                                  disabled={scm.actionBusy !== null}
                                  onOpenFileDiff={scm.openFileDiff}
                                  onToggleStageFile={scm.toggleStageFile}
                                  onDiscardFile={scm.requestDiscardFile}
                                  onOpenFile={onOpenFile}
                                />
                              )}
                            </ContextMenu>
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
              // 根目录检测期间快照仍可能属于上一 Space，不能继续展示其提交图。
              render: ({ expanded, present }) =>
                graphLoading ? (
                  open && present ? (
                    <SourceControlLoading
                      label={t("gitHistory:loadingCommits")}
                      active={expanded}
                    />
                  ) : null
                ) : (
                  <GraphSection
                    key={graphRepoRoot}
                    repoRoot={graphRepoRoot}
                    headBranch={scm.status?.branch ?? null}
                    headSha={scm.status?.headSha ?? null}
                    expanded={open && expanded}
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
  hovered: boolean;
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
  hovered,
  actionBusy,
  repoRoot,
  onFocusRow,
  onOpenFileDiff,
  onToggleStageFile,
  onDiscardFile,
  onOpenFile,
}: EntryRowProps) {
  const { t } = useTranslation("sourceControl");
  const interactive = hovered || focused;
  const fileName = basename(entry.path);
  const iconUrl = fileIconUrl(fileName);
  const pathLabel = entryPathLabel(entry);
  const isDeleted = entry.statusCode === "D";
  const showDiscard = entry.side === "worktree";
  const isStageBusy =
    actionBusy === `stage:${entry.path}` ||
    actionBusy === `unstage:${entry.path}`;
  const isDiscardBusy = actionBusy === `discard:${entry.path}`;
  const disabled = actionBusy !== null;

  const absolutePath = repoRoot
    ? joinPath(repoRoot.replace(/\\/g, "/"), entry.path.replace(/\\/g, "/"))
    : null;
  return (
    <div
      id={`scm-row-${entry.key}`}
      data-view-row={entry.key}
      data-scm-row-key={entry.key}
      data-focused={focused || undefined}
      role="option"
      aria-selected={focused}
      tabIndex={-1}
      onMouseDown={() => onFocusRow(entry.key)}
      onFocusCapture={() => onFocusRow(entry.key)}
      className={cn(
        "group flex h-6 items-center gap-1.5 rounded-sm px-1.5 transition-colors duration-feedback",
        focused ? "bg-interactive-active" : "hover:bg-interactive-hover",
      )}
    >
      <button
        data-scm-file
        type="button"
        onClick={() => {
          onFocusRow(entry.key);
          onOpenFileDiff(entry);
        }}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
      >
        {iconUrl ? (
          <img
            src={iconUrl}
            alt=""
            className="file-type-icon size-4 shrink-0"
          />
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
              isDeleted && "line-through",
            )}
          >
            {fileName}
          </span>
          {pathLabel ? (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[10px] leading-none text-muted-foreground",
                isDeleted && "line-through",
              )}
            >
              {pathLabel}
            </span>
          ) : null}
        </div>
      </button>

      {interactive && (
        <div className="flex shrink-0 items-center">
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
      )}
      <span
        className={cn(
          "w-3 shrink-0 text-right font-mono text-[12px] font-bold",
          explorerGitTextClass(entry.statusCode),
        )}
      >
        {entry.statusCode}
      </span>
    </div>
  );
});

/** 菜单由整个 Changes 列表共享，操作始终使用当前快照中的目标条目。 */
function EntryContextMenu({
  entry,
  repoRoot,
  disabled,
  onOpenFileDiff,
  onToggleStageFile,
  onDiscardFile,
  onOpenFile,
}: Pick<
  EntryRowProps,
  | "entry"
  | "repoRoot"
  | "onOpenFileDiff"
  | "onToggleStageFile"
  | "onDiscardFile"
  | "onOpenFile"
> & { disabled: boolean }) {
  const { t } = useTranslation("sourceControl");
  const absolutePath = repoRoot
    ? joinPath(repoRoot.replace(/\\/g, "/"), entry.path.replace(/\\/g, "/"))
    : null;
  const revealLabel = IS_MAC
    ? t("menu.revealInFinder")
    : t("menu.revealInFileManager");
  return (
    <ContextMenuContent>
      {/* 打开操作 */}
      <ContextMenuItem
        onSelect={() => {
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

      {/* 暂存与取消暂存 */}
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

      {/* 复制路径 */}
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

      {/* 仅为仍存在的文件提供定位操作 */}
      {entry.canOpenFile && absolutePath ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void revealInFinder(absolutePath)}>
            {revealLabel}
          </ContextMenuItem>
        </>
      ) : null}
    </ContextMenuContent>
  );
}

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
