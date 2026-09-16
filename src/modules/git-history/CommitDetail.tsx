/**
 * 本文件渲染 Git 提交详情和文件变更列表。
 * 提交说明、作者信息和文件路径需在紧凑布局下保持可读。
 */

import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { GitCommitFileChange, GitLogEntry } from "@/modules/ai/lib/native";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  Copy01Icon,
  LinkSquare02Icon,
  Tick02Icon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export type CommitDetailFilesEntry =
  | { state: "loading" }
  | { state: "loaded"; files: GitCommitFileChange[]; message: string }
  | { state: "error"; error: string };

type Props = {
  commit: GitLogEntry;
  filesEntry: CommitDetailFilesEntry | null;
  onOpenFile: (file: GitCommitFileChange) => void;
  onRetry: () => void;
  onUndo?: () => void;
  remoteAction?: { label: string; onClick: () => void };
};

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "" : normalized.slice(0, index);
}

function commitBody(commit: GitLogEntry, message: string): string {
  const normalized = message.trim();
  if (!normalized) return "";
  const firstBreak = normalized.indexOf("\n");
  if (firstBreak === -1) return normalized === commit.subject ? "" : normalized;
  const firstLine = normalized.slice(0, firstBreak).trimEnd();
  return firstLine === commit.subject
    ? normalized.slice(firstBreak + 1).trim()
    : normalized;
}

function statusBadgeClass(status: string): string {
  switch (status.toUpperCase()) {
    case "A":
      return "text-success";
    case "M":
      return "text-warning";
    case "D":
      return "text-destructive";
    case "R":
    case "C":
      return "text-info";
    default:
      return "text-muted-foreground";
  }
}

/**
 * Git 提交详情视图。
 *
 * 展示提交元信息和文件变更，并提供使用统一交互语义色的文件打开入口。
 */
export function CommitDetail({
  commit,
  filesEntry,
  onOpenFile,
  onRetry,
  onUndo,
  remoteAction,
}: Props) {
  const { t, i18n } = useTranslation("gitHistory");
  const [copiedSha, setCopiedSha] = useState<string | null>(null);
  const body =
    filesEntry?.state === "loaded"
      ? commitBody(commit, filesEntry.message)
      : "";

  useEffect(() => {
    if (copiedSha !== commit.sha) return;
    const timer = window.setTimeout(() => setCopiedSha(null), 1100);
    return () => window.clearTimeout(timer);
  }, [commit.sha, copiedSha]);

  return (
    <div className="flex max-h-[60vh] min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/45 p-3">
        <div className="flex items-start gap-2">
          <span className="mt-px shrink-0 rounded bg-muted/65 px-1.5 py-0.5 font-mono text-[10.5px] leading-none tabular-nums text-muted-foreground">
            {commit.shortSha}
          </span>
          <div className="min-w-0 flex-1 text-[12.5px] font-semibold leading-snug text-foreground">
            {commit.subject || (
              <span className="text-muted-foreground">{t("noSubject")}</span>
            )}
          </div>
        </div>
        {body ? (
          <div className="app-scrollbar mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-foreground">
            {body}
          </div>
        ) : null}
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="truncate">
            {commit.author || t("unknownAuthor")}
          </span>
          {commit.authorEmail ? (
            <>
              <span className="text-muted-foreground/45">·</span>
              <span className="truncate text-muted-foreground">
                {commit.authorEmail}
              </span>
            </>
          ) : null}
          <span className="text-muted-foreground/45">·</span>
          <span className="shrink-0 tabular-nums">
            {new Date(commit.timestampSecs * 1000).toLocaleString(
              i18n.language,
            )}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            className="cursor-pointer gap-1.5"
            onClick={() => {
              void navigator.clipboard
                .writeText(commit.sha)
                .then(() => setCopiedSha(commit.sha))
                .catch(() => undefined);
            }}
          >
            <HugeiconsIcon
              icon={copiedSha === commit.sha ? Tick02Icon : Copy01Icon}
              size={11}
              strokeWidth={1.9}
            />
            {copiedSha === commit.sha ? t("copied") : t("copySha")}
          </Button>
          {onUndo ? (
            <Button
              size="xs"
              variant="ghost"
              className="cursor-pointer gap-1.5"
              onClick={onUndo}
            >
              <HugeiconsIcon icon={Undo02Icon} size={11} strokeWidth={1.9} />
              {t("undo")}
            </Button>
          ) : null}
          {remoteAction ? (
            <Button
              size="xs"
              variant="ghost"
              className="cursor-pointer gap-1.5"
              onClick={remoteAction.onClick}
            >
              <HugeiconsIcon
                icon={LinkSquare02Icon}
                size={11}
                strokeWidth={1.9}
              />
              {remoteAction.label}
            </Button>
          ) : null}
        </div>
        <div className="mt-2 border-t border-border/40 pt-2 text-[10.5px] tabular-nums text-muted-foreground">
          {t("filesChanged", { count: commit.filesChanged })}
          {commit.insertions > 0 ? (
            <span className="ml-1.5 font-semibold text-success">
              {t("insertions", { count: commit.insertions })}
            </span>
          ) : null}
          {commit.deletions > 0 ? (
            <span className="ml-1.5 font-semibold text-destructive">
              {t("deletions", { count: commit.deletions })}
            </span>
          ) : null}
        </div>
      </div>

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-1.5">
        {!filesEntry || filesEntry.state === "loading" ? (
          <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-muted-foreground">
            <Spinner className="size-3" /> {t("loadingFiles")}
          </div>
        ) : filesEntry.state === "error" ? (
          <div className="flex items-center justify-between gap-2 px-2 py-2 text-[11px] text-destructive">
            <span className="truncate">{filesEntry.error}</span>
            <Button size="xs" variant="ghost" onClick={onRetry}>
              {t("retry")}
            </Button>
          </div>
        ) : filesEntry.files.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-muted-foreground">
            {t("noFileChanges")}
          </div>
        ) : (
          filesEntry.files.map((file) => (
            <CommitFileRow
              key={`${file.status}:${file.path}`}
              file={file}
              onOpen={() => onOpenFile(file)}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function CommitFileRow({
  file,
  onOpen,
  showStats = true,
  selected = false,
}: {
  file: GitCommitFileChange;
  onOpen: () => void;
  showStats?: boolean;
  selected?: boolean;
}) {
  const { t } = useTranslation("gitHistory");
  const name = basename(file.path);
  const pathLabel = file.originalPath
    ? `${file.originalPath} → ${file.path}`
    : dirname(file.path);
  const iconUrl = fileIconUrl(name);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded px-1.5 text-left",
        selected
          ? "bg-interactive-active hover:bg-interactive-active"
          : "hover:bg-interactive-hover",
        showStats ? "h-7" : "h-6",
      )}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="size-3.5 shrink-0" />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-none">
        <span className="truncate text-[11.5px] font-medium">{name}</span>
        {pathLabel ? (
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
            {pathLabel}
          </span>
        ) : null}
      </div>
      <Hint content={file.statusLabel}>
        <span
          className={cn(
            "inline-flex size-4 shrink-0 items-center justify-center text-[9px] font-bold",
            statusBadgeClass(file.status),
          )}
        >
          {file.status.toUpperCase()}
        </span>
      </Hint>
      {showStats ? (
        file.isBinary ? (
          <span className="w-16 shrink-0 text-right text-[10px] text-muted-foreground">
            {t("binary")}
          </span>
        ) : (
          <span className="flex w-16 shrink-0 justify-end gap-1.5 text-[10px] tabular-nums">
            <span className="text-success">+{file.added}</span>
            <span className="text-destructive">−{file.removed}</span>
          </span>
        )
      ) : null}
    </button>
  );
}
