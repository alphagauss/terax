/** 单文件 Git 时间线；分页与 Graph 共用，历史记录直接打开对应文件的提交 Diff。 */

import { Button } from "@/components/controls/button";
import { Spinner } from "@/components/ui/spinner";
import { type CommitFileDiffOpenInput, native } from "@/modules/ai/lib/native";
import { CommitHistoryHoverCard } from "@/modules/git-history/CommitHistoryHoverCard";
import { commitHoverInteraction } from "@/modules/git-history/CommitGraphInteraction";
import { useCommitGraph } from "@/modules/git-history/useCommitGraph";
import { useCommitHistory } from "@/modules/git-history/useCommitHistory";
import { relativeTime } from "@/modules/source-control/relativeTime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

const ROW_HEIGHT = 24;
const NEAR_BOTTOM_PX = 180;

/** 只在可见且展开时读取历史，文件或 HEAD 变化立即隔离上一查询。 */
export function FileTimeline({
  repoRoot,
  headSha,
  path,
  enabled,
  present,
  refreshToken,
  onOpenCommitFile,
}: {
  repoRoot: string | null;
  headSha: string | null;
  path: string | null;
  enabled: boolean;
  present: boolean;
  refreshToken: number;
  onOpenCommitFile?: (input: CommitFileDiffOpenInput) => void;
}) {
  const { t, i18n } = useTranslation("gitHistory");
  const scrollRef = useRef<HTMLElement>(null);
  const scrollTop = useRef(0);
  const attachScroll = useCallback((element: HTMLElement | null) => {
    scrollRef.current = element;
    if (element) element.scrollTop = scrollTop.current;
  }, []);
  const queryKey =
    repoRoot && path && headSha
      ? JSON.stringify([repoRoot, path, headSha, refreshToken])
      : null;
  const graph = useCommitGraph(repoRoot, enabled && present);
  const { reset, close } = graph;
  useEffect(() => {
    void queryKey;
    reset();
  }, [queryKey, reset]);
  const fetchPage = useCallback(
    (options: { limit: number; skip?: number }) =>
      repoRoot && path && headSha
        ? native.gitFileHistory(repoRoot, path, headSha, options)
        : Promise.resolve([]),
    [repoRoot, path, headSha],
  );
  const onInitialLoaded = useCallback(() => {
    scrollTop.current = 0;
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);
  const { commits, loadStatus, error, endReached, loadInitial, loadMore } =
    useCommitHistory({
      queryKey,
      enabled,
      fetchPage,
      onInitialLoaded,
    });
  const virtualizer = useVirtualizer({
    enabled: present,
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    initialOffset: () => scrollTop.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => commits[index].sha,
    overscan: 8,
  });

  useEffect(() => {
    if (!enabled || loadStatus !== "idle" || endReached) return;
    const scroll = scrollRef.current;
    if (scroll && scroll.scrollHeight <= scroll.clientHeight + NEAR_BOTTOM_PX) {
      const timer = window.setTimeout(() => void loadMore(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [enabled, loadStatus, endReached, loadMore]);

  const selectedCommit =
    commits.find((commit) => commit.sha === graph.anchor?.sha) ?? null;
  const selectedFiles = selectedCommit
    ? graph.files.get(selectedCommit.sha)
    : undefined;
  // 文件历史首屏不加载全提交统计，悬停后复用详情缓存中的真实文件统计。
  const detailCommit =
    selectedCommit && selectedFiles?.state === "loaded"
      ? {
          ...selectedCommit,
          filesChanged: selectedFiles.files.length,
          insertions: selectedFiles.files.reduce(
            (total, file) => total + file.added,
            0,
          ),
          deletions: selectedFiles.files.reduce(
            (total, file) => total + file.removed,
            0,
          ),
        }
      : selectedCommit;

  if (!present) return null;
  const emptyMessage = !repoRoot
    ? t("timeline.noRepository")
    : !path
      ? t("timeline.selectFile")
      : !headSha || (commits.length === 0 && loadStatus === "idle")
        ? t("timeline.noHistory")
        : null;
  if (emptyMessage)
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
        {emptyMessage}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <section
        ref={attachScroll}
        aria-label={t("timeline.title")}
        className="app-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
        onScroll={(event) => {
          close();
          if (enabled) scrollTop.current = event.currentTarget.scrollTop;
          const {
            scrollHeight,
            scrollTop: top,
            clientHeight,
          } = event.currentTarget;
          if (scrollHeight - top - clientHeight < NEAR_BOTTOM_PX)
            void loadMore();
        }}
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((row) => {
            const commit = commits[row.index];
            return (
              <button
                key={commit.sha}
                {...commitHoverInteraction(graph, commit.sha)}
                type="button"
                aria-label={`${commit.shortSha} ${commit.subject}`}
                className="absolute left-0 flex w-full cursor-pointer items-center gap-2 px-3 text-left hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                style={{ top: row.start, height: ROW_HEIGHT }}
                onClick={() => {
                  if (repoRoot)
                    onOpenCommitFile?.({
                      repoRoot,
                      sha: commit.sha,
                      shortSha: commit.shortSha,
                      subject: commit.subject,
                      path: commit.path,
                      originalPath: commit.originalPath,
                    });
                  graph.dismiss();
                }}
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                  {commit.subject || t("noSubject")}
                </span>
                <span className="shrink-0 text-right text-[10.5px] tabular-nums text-muted-foreground">
                  {relativeTime(commit.timestampSecs, i18n.language)}
                </span>
              </button>
            );
          })}
        </div>
        {loadStatus === "initial" || loadStatus === "more" ? (
          <div
            className="flex items-center justify-center gap-2 p-3 text-[11px] text-muted-foreground"
            role="status"
          >
            <Spinner className="size-3" />
            {t(loadStatus === "initial" ? "loadingCommits" : "loadingMore")}
          </div>
        ) : null}
        {error ? (
          <div className="flex flex-col items-center gap-2 p-3 text-[11px]">
            <span className="break-all text-destructive" role="alert">
              {error}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void (loadStatus === "initial-error"
                  ? loadInitial()
                  : loadMore())
              }
            >
              {t("retry")}
            </Button>
          </div>
        ) : null}
      </section>
      {repoRoot ? (
        <CommitHistoryHoverCard
          repoRoot={repoRoot}
          commit={detailCommit}
          graph={graph}
          onOpenFile={(file) => {
            if (selectedCommit)
              onOpenCommitFile?.({
                repoRoot,
                sha: selectedCommit.sha,
                shortSha: selectedCommit.shortSha,
                subject: selectedCommit.subject,
                path: file.path,
                originalPath: file.originalPath,
              });
          }}
        />
      ) : null}
    </div>
  );
}
