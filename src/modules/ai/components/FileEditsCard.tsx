/** 轮末净改动卡片。统一悬停提示打开后才挂载快照 Diff，点击交给 Workbench 打开整轮。 */
import { summarizeFileEdits } from "@/modules/ai/lib/fileEditDiff";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/controls/tooltip";
import { DiffStats } from "@/modules/ai/components/FileEditStats";
import type { FileEditFile, TurnFileEdits } from "@/modules/ai/lib/fileEdits";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { ReadonlyDiff } from "@/modules/editor/ReadonlyDiffLazy";

export function FileEditsCard({
  sessionId,
  edits,
}: {
  sessionId: string;
  edits: TurnFileEdits;
}) {
  const { t } = useTranslation("ai");
  const [expanded, setExpanded] = useState(false);
  const files = useMemo(() => summarizeFileEdits(edits), [edits]);
  const totals = files.reduce(
    (sum, file) => ({
      added: sum.added + file.added,
      removed: sum.removed + file.removed,
    }),
    { added: 0, removed: 0 },
  );
  if (!files.length && !edits.uncertainPaths.length) return null;
  const open = (identity: string) =>
    useChatStore
      .getState()
      .live.openFileEdits?.({ sessionId, edits, selectedIdentity: identity });
  return (
    <div className="not-prose mt-3 overflow-hidden rounded-md border border-border/60 bg-card text-xs">
      <div className="flex items-center gap-3 border-b border-border/40 px-3 py-2">
        <span className="flex-1 font-medium">
          {files.length
            ? t("chat.fileEdits.title", { count: files.length })
            : t("chat.fileEdits.tabTitle")}
        </span>
        {files.length > 0 && <DiffStats stats={totals} />}
      </div>
      {(expanded ? files : files.slice(0, 3)).map((file) => (
        <FileRow
          key={file.identity}
          file={file}
          onOpen={() => open(file.identity)}
        />
      ))}
      {edits.uncertainPaths.length > 0 && (
        <div className="px-3 py-2 text-destructive">
          {t("chat.fileEdits.uncertainPaths", {
            paths: edits.uncertainPaths.join(", "),
          })}
        </div>
      )}
      {files.length > 3 && (
        <button
          type="button"
          className="w-full border-t border-border/40 px-3 py-2 text-left text-muted-foreground hover:bg-interactive-hover"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? t("chat.fileEdits.collapse")
            : t("chat.fileEdits.more", { count: files.length - 3 })}
        </button>
      )}
    </div>
  );
}

function FileRow({ file, onOpen }: { file: FileEditFile; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-interactive-hover"
        >
          <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
          <DiffStats stats={file} />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="flex w-[min(640px,calc(100vw-24px))] max-w-none flex-col items-stretch gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center gap-3 border-b border-border/50 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
          <DiffStats stats={file} />
        </div>
        {open && <FileDiffSegments file={file} preview />}
      </TooltipContent>
    </Tooltip>
  );
}

/** 只有基线不连续时显示分段提示，各段只呈现工具已提交的内容。 */
export function FileDiffSegments({
  file,
  preview = false,
}: {
  file: FileEditFile;
  preview?: boolean;
}) {
  const { t } = useTranslation("ai");
  return (
    <div
      className={
        preview ? "max-h-[min(420px,60vh)] overflow-y-auto" : "space-y-2"
      }
    >
      {file.segments.length > 1 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t("chat.fileEdits.discontinuous")}
        </p>
      )}
      {file.segments.map((segment, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 轮末快照不可变，分段顺序不会重排。
          key={`${file.identity}:${index}`}
          className={preview ? "h-80" : "h-[min(520px,65vh)]"}
        >
          <ReadonlyDiff
            path={file.path}
            before={segment.before}
            after={segment.after}
            preview={preview}
          />
        </div>
      ))}
    </div>
  );
}
