/** Workbench 中查看一轮已提交的文件快照，按需展开各文件，不读取当前磁盘。 */
import { summarizeFileEdits } from "@/modules/ai/lib/fileEditDiff";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { DiffStats } from "@/modules/ai/components/FileEditStats";
import { FileDiffSegments } from "@/modules/ai/components/FileEditsCard";
import type { FileEditsTab } from "@/modules/workbench/types";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export function FileEditsView({ tab }: { tab: FileEditsTab }) {
  const { t } = useTranslation("ai");
  const files = useMemo(() => summarizeFileEdits(tab.edits), [tab.edits]);
  const [open, setOpen] = useState(() => new Set([tab.selectedIdentity]));
  const rows = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    setOpen((previous) => new Set([...previous, tab.selectedIdentity]));
    const frame = requestAnimationFrame(() =>
      rows.current
        .get(tab.selectedIdentity)
        ?.scrollIntoView({ block: "start" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [tab]);
  const totals = files.reduce(
    (sum, file) => ({
      added: sum.added + file.added,
      removed: sum.removed + file.removed,
    }),
    { added: 0, removed: 0 },
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-4 py-3 text-sm">
        <span>{t("chat.fileEdits.title", { count: files.length })}</span>
        <DiffStats stats={totals} />
      </div>
      <div className="app-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {files.map((file) => (
          <div
            key={file.identity}
            ref={(element) => {
              if (element) rows.current.set(file.identity, element);
              else rows.current.delete(file.identity);
            }}
          >
            <Collapsible
              open={open.has(file.identity)}
              onOpenChange={(expanded) =>
                setOpen((previous) => {
                  const next = new Set(previous);
                  if (expanded) next.add(file.identity);
                  else next.delete(file.identity);
                  return next;
                })
              }
            >
              <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-md bg-muted/40 px-3 py-2 text-left text-xs">
                <span className="min-w-0 flex-1 truncate font-mono">
                  {file.path}
                </span>
                <DiffStats stats={file} />
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={13}
                  className={open.has(file.identity) ? "rotate-180" : ""}
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                {open.has(file.identity) && <FileDiffSegments file={file} />}
              </CollapsibleContent>
            </Collapsible>
          </div>
        ))}
        {tab.edits.uncertainPaths.length > 0 && (
          <p className="text-xs text-destructive">
            {t("chat.fileEdits.uncertainPaths", {
              paths: tab.edits.uncertainPaths.join(", "),
            })}
          </p>
        )}
      </div>
    </div>
  );
}
