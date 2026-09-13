/** 图谱共用的可交互悬停详情，以及展开后文件行的轨道和状态展示。 */

import { Button } from "@/components/controls/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { CommitFileRow } from "@/modules/git-history/CommitDetail";
import { GraphContinuation } from "@/modules/git-history/GraphRail";
import type { GraphRow } from "@/modules/git-history/lib/graph";
import type {
  CommitGraphItem,
  useCommitGraph,
} from "@/modules/git-history/useCommitGraph";
import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

type Controller = ReturnType<typeof useCommitGraph>;

/** 两处入口使用相同触发规则；F2 可将键盘焦点移入详情。 */
export function commitRowInteraction(graph: Controller, sha: string) {
  return {
    "aria-expanded": graph.expanded.has(sha),
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch") graph.enter(sha, event.currentTarget);
    },
    onPointerLeave: graph.leave,
    onFocus: (event: React.FocusEvent<HTMLElement>) =>
      graph.enter(sha, event.currentTarget),
    onBlur: graph.leave,
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") graph.dismiss();
      if (event.key === "F2") {
        event.preventDefault();
        graph.enter(sha, event.currentTarget, true);
      }
      if (
        (event.key === "ArrowRight" && !graph.expanded.has(sha)) ||
        (event.key === "ArrowLeft" && graph.expanded.has(sha))
      ) {
        event.preventDefault();
        graph.toggle(sha);
      }
    },
  };
}

export function CommitHoverCard({
  graph,
  side,
  children,
}: {
  graph: Controller;
  side: "right" | "bottom";
  children: ReactNode;
}) {
  const { t } = useTranslation("gitHistory");
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (graph.anchor?.focus)
      content.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [graph.anchor]);
  return (
    <Popover
      open={!!graph.anchor}
      onOpenChange={(open) => {
        if (!open) graph.dismiss();
      }}
    >
      <PopoverAnchor virtualRef={{ current: graph.anchor?.element ?? null }} />
      <PopoverContent
        ref={content}
        aria-label={t("commitDetails")}
        side={side}
        align="start"
        sideOffset={6}
        collisionPadding={12}
        onPointerEnter={graph.keepOpen}
        onPointerLeave={(event) => {
          if (
            !graph.anchor?.focus ||
            !event.currentTarget.contains(document.activeElement)
          )
            graph.leave();
        }}
        onFocusCapture={graph.keepOpen}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) graph.leave();
        }}
        onOpenAutoFocus={(event) => {
          if (!graph.anchor?.focus) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => {
          graph.anchor?.element.focus({ preventScroll: true });
          graph.dismiss();
        }}
        className="flex w-[420px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-lg p-0"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function ExpandedCommitRow({
  item,
  row,
  maxLaneCount,
  railSpace,
  rowHeight,
  onOpen,
  onRetry,
}: {
  item: Exclude<CommitGraphItem, { kind: "commit" }>;
  row: GraphRow | null;
  maxLaneCount: number;
  railSpace?: number;
  rowHeight: number;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation("gitHistory");
  return (
    <div className="flex h-full items-center">
      <div
        className={railSpace ? "shrink-0 pl-1" : "shrink-0"}
        style={{ width: railSpace }}
      >
        {row ? (
          <GraphContinuation
            row={row}
            rowHeight={rowHeight}
            maxLaneCount={maxLaneCount}
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1 pr-2">
        {item.kind === "file" ? (
          <CommitFileRow file={item.file} onOpen={onOpen} showStats={false} />
        ) : (
          <div className="flex items-center gap-2 px-1.5 text-[11px] text-muted-foreground">
            {item.entry?.state === "error" ? (
              <>
                <span className="truncate text-destructive">
                  {item.entry.error}
                </span>
                <Button size="xs" variant="ghost" onClick={onRetry}>
                  {t("retry")}
                </Button>
              </>
            ) : item.entry?.state === "loaded" ? (
              t("noFileChanges")
            ) : (
              t("loadingFiles")
            )}
          </div>
        )}
      </div>
    </div>
  );
}
