/**
 * 本文件渲染资源管理器的普通条目、创建输入和加载状态行。
 * 条目行负责展示选择、重命名、Git 装饰和删除中的不可交互状态。
 */

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { InlineInput } from "./InlineInput";
import { explorerGitTextClass } from "./lib/gitStatusColor";
import type { GitStatusCode } from "./lib/gitStatusUtils";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";

const DELETE_STATUS_DELAY_MS = 160;

export type RowActions = {
  toggle: (path: string) => void;
  beginRename: (path: string) => void;
  commitRename: (newName: string) => void | Promise<void>;
  cancelRename: () => void;
};

export type EntryRowProps = {
  domId: string;
  path: string;
  name: string;
  isDir: boolean;
  isExpanded: boolean;
  isDeleting: boolean;
  depth: number;
  actions: RowActions;
  renameInProgress: boolean;
  isSelected: boolean;
  isContextTarget?: boolean;
  isRenaming: boolean;
  isDropTarget?: boolean;
  onOpenFile: (path: string, pin?: boolean) => void;
  onSelectPath: (path: string) => void;
  gitStatusCode?: GitStatusCode | null;
  gitignored?: boolean;
  deletingLabel: string;
};

function EntryRowImpl(props: EntryRowProps) {
  const {
    domId,
    path,
    name,
    isDir,
    isExpanded,
    isDeleting,
    depth,
    actions,
    renameInProgress,
    isSelected,
    isContextTarget = false,
    isRenaming,
    isDropTarget = false,
    onOpenFile,
    onSelectPath,
    gitStatusCode,
    gitignored = false,
    deletingLabel,
  } = props;

  const iconUrl = isDir ? folderIconUrl(name, isExpanded) : fileIconUrl(name);
  const paddingLeft = 6 + depth * 12;
  const [showDeletingStatus, setShowDeletingStatus] = useState(false);

  useEffect(() => {
    if (!isDeleting) {
      setShowDeletingStatus(false);
      return;
    }
    const timer = window.setTimeout(
      () => setShowDeletingStatus(true),
      DELETE_STATUS_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [isDeleting]);

  if (isRenaming) {
    return (
      <div
        id={domId}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={isSelected}
        tabIndex={-1}
        className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
        style={{ paddingLeft }}
      >
        <span className="size-3.5 shrink-0" />
        {iconUrl ? (
          <img src={iconUrl} alt="" className="size-4 shrink-0" />
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <InlineInput
          initial={name}
          onCommit={actions.commitRename}
          onCancel={actions.cancelRename}
        />
      </div>
    );
  }

  const handleClick = () => {
    if (renameInProgress || isDeleting) return;
    onSelectPath(path);
    if (isDir) actions.toggle(path);
    else onOpenFile(path);
  };

  return (
    <button
      id={domId}
      type="button"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isDir ? isExpanded : undefined}
      aria-selected={isSelected}
      aria-busy={isDeleting || undefined}
      aria-disabled={isDeleting || undefined}
      tabIndex={-1}
      data-fs-path={path}
      data-fs-deleting={isDeleting ? "" : undefined}
      disabled={isDeleting}
      onClick={handleClick}
      onDoubleClick={() => !isDir && onOpenFile(path, true)}
      className={cn(
        "group flex h-6 w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-left text-[13px] transition-colors hover:bg-accent/70",
        isDeleting &&
          "cursor-wait text-muted-foreground hover:bg-transparent disabled:opacity-80",
        isContextTarget
          ? "bg-accent text-foreground"
          : isSelected
            ? "bg-primary/12 text-foreground ring-1 ring-inset ring-primary/70"
            : gitignored
              ? "text-muted-foreground"
              : "text-foreground",
        isDropTarget && "bg-primary/10 ring-1 ring-inset ring-primary/60",
      )}
      style={{ paddingLeft }}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {isDir ? (
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={12}
            strokeWidth={2.25}
            className={cn("transition-transform", isExpanded && "rotate-90")}
          />
        ) : null}
      </span>
      {iconUrl ? (
        <img src={iconUrl} alt="" className="size-4 shrink-0" />
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          !gitignored && gitStatusCode && explorerGitTextClass(gitStatusCode),
        )}
      >
        {name}
      </span>
      {!isDir && (gitStatusCode === "M" || gitStatusCode === "U") ? (
        <span
          aria-hidden="true"
          className={cn(
            "w-3 shrink-0 text-right font-mono text-[10px]",
            explorerGitTextClass(gitStatusCode),
          )}
        >
          {gitStatusCode}
        </span>
      ) : null}
      {showDeletingStatus ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-destructive">
          <Spinner
            className="size-3 motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span>{deletingLabel}</span>
        </span>
      ) : null}
    </button>
  );
}

/**
 * 资源管理器普通条目行。
 *
 * 删除中的条目保持可见但完全禁用，并在右侧展示不确定进度反馈。
 */
export const EntryRow = memo(EntryRowImpl);

export type PendingRowProps = {
  depth: number;
  kind: "file" | "dir";
  onCommit: (name: string) => void | Promise<void>;
  onCancel: () => void;
};

export function PendingRow({
  depth,
  kind,
  onCommit,
  onCancel,
}: PendingRowProps) {
  const { t } = useTranslation("explorer");
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      tabIndex={-1}
      className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <span className="size-3.5 shrink-0" />
      <img
        src={
          kind === "dir" ? folderIconUrl("", false) : fileIconUrl("untitled")
        }
        alt=""
        className="size-4 shrink-0 opacity-70"
      />
      <InlineInput
        initial=""
        placeholder={kind === "dir" ? t("newFolder") : t("newFile")}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

export function StatusRow({
  depth,
  message,
  tone,
}: {
  depth: number;
  message: string;
  tone: "muted" | "error";
}) {
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-disabled
      tabIndex={-1}
      className={cn(
        "h-6 truncate px-2 text-[11px] leading-6",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      style={{ paddingLeft: 6 + depth * 12 + 18 }}
    >
      {message}
    </div>
  );
}
