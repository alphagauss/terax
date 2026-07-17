import { Button } from "@/components/ui/button";
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
      return "text-emerald-600 dark:text-emerald-400";
    case "M":
      return "text-amber-600 dark:text-amber-300";
    case "D":
      return "text-rose-600 dark:text-rose-400";
    case "R":
    case "C":
      return "text-sky-600 dark:text-sky-300";
    default:
      return "text-muted-foreground";
  }
}

export function CommitDetail({
  commit,
  filesEntry,
  onOpenFile,
  onRetry,
  onUndo,
  remoteAction,
}: Props) {
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
              <span className="text-muted-foreground">(no subject)</span>
            )}
          </div>
        </div>
        {body ? (
          <div className="app-scrollbar mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-foreground/80">
            {body}
          </div>
        ) : null}
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="truncate">{commit.author || "Unknown"}</span>
          {commit.authorEmail ? (
            <>
              <span className="text-muted-foreground/45">·</span>
              <span className="truncate text-muted-foreground/85">
                {commit.authorEmail}
              </span>
            </>
          ) : null}
          <span className="text-muted-foreground/45">·</span>
          <span className="shrink-0 tabular-nums">
            {new Date(commit.timestampSecs * 1000).toLocaleString()}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            className="h-6 cursor-pointer gap-1.5 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
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
            {copiedSha === commit.sha ? "Copied" : "Copy SHA"}
          </Button>
          {onUndo ? (
            <Button
              size="xs"
              variant="ghost"
              className="h-6 cursor-pointer gap-1.5 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onUndo}
            >
              <HugeiconsIcon icon={Undo02Icon} size={11} strokeWidth={1.9} />
              Undo
            </Button>
          ) : null}
          {remoteAction ? (
            <Button
              size="xs"
              variant="ghost"
              className="h-6 cursor-pointer gap-1.5 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
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
          Changed {commit.filesChanged}{" "}
          {commit.filesChanged === 1 ? "file" : "files"}
          {commit.insertions > 0 ? (
            <span className="ml-1.5 font-semibold text-emerald-600 dark:text-emerald-400">
              {commit.insertions} insertions(+)
            </span>
          ) : null}
          {commit.deletions > 0 ? (
            <span className="ml-1.5 font-semibold text-rose-600 dark:text-rose-400">
              {commit.deletions} deletions(-)
            </span>
          ) : null}
        </div>
      </div>

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-1.5">
        {!filesEntry || filesEntry.state === "loading" ? (
          <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-muted-foreground">
            <Spinner className="size-3" /> Loading files…
          </div>
        ) : filesEntry.state === "error" ? (
          <div className="flex items-center justify-between gap-2 px-2 py-2 text-[11px] text-destructive">
            <span className="truncate">{filesEntry.error}</span>
            <Button size="xs" variant="ghost" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : filesEntry.files.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-muted-foreground">
            No file changes.
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

function CommitFileRow({
  file,
  onOpen,
}: {
  file: GitCommitFileChange;
  onOpen: () => void;
}) {
  const name = basename(file.path);
  const dir = dirname(file.path);
  const iconUrl = fileIconUrl(name);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-7 w-full cursor-pointer items-center gap-2 rounded px-1.5 text-left hover:bg-accent/40"
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="size-3.5 shrink-0" />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-none">
        <span className="truncate text-[11.5px] font-medium">{name}</span>
        {dir ? (
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/80">
            {dir}
          </span>
        ) : null}
      </div>
      <span
        title={file.statusLabel}
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center text-[9px] font-bold",
          statusBadgeClass(file.status),
        )}
      >
        {file.status.toUpperCase()}
      </span>
      {file.isBinary ? (
        <span className="w-16 shrink-0 text-right text-[10px] text-muted-foreground">
          binary
        </span>
      ) : (
        <span className="flex w-16 shrink-0 justify-end gap-1.5 text-[10px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">
            +{file.added}
          </span>
          <span className="text-rose-600 dark:text-rose-400">
            −{file.removed}
          </span>
        </span>
      )}
    </button>
  );
}
