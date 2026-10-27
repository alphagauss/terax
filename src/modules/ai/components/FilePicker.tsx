/**
 * 本文件实现 AI Composer 的文件选择浮层。
 * 负责按 Space 展示当前进程内已经打开的文件。
 */

import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { OpenFileGroup } from "@/modules/ai/lib/openFileCandidates";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { DEFAULT_SPACE_ID } from "@/modules/workbench/types";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  groups: readonly OpenFileGroup[];
  activeIndex: number;
  hasOpenFiles: boolean;
  onPick: (file: string) => void;
  onHover: (index: number) => void;
};

/** 展示按 Space 分组的已打开文件，并支持键盘高亮项自动滚入视口。 */
export function FilePickerContent({
  groups,
  activeIndex,
  hasOpenFiles,
  onPick,
  onHover,
}: Props) {
  const { t } = useTranslation(["ai", "spaces"]);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={6}
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      className="w-80 overflow-hidden rounded-lg border border-border/60 bg-popover/95 p-0 shadow-xl backdrop-blur-xl"
    >
      {!hasOpenFiles ? (
        <div className="px-3 py-3 text-[11px] text-muted-foreground">
          {t("ai:filePicker.noOpenFiles")}
        </div>
      ) : groups.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-muted-foreground">
          {t("ai:filePicker.noMatches")}
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto py-1">
          {groups.map((group, groupIndex) => {
            const startIndex = groups
              .slice(0, groupIndex)
              .reduce((total, item) => total + item.files.length, 0);
            const spaceName =
              group.spaceId === DEFAULT_SPACE_ID
                ? t("spaces:defaultSpace")
                : group.name;
            return (
              <div key={group.spaceId}>
                <div className="flex items-center gap-2 px-2 py-1 text-[12px] font-semibold text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {group.current
                      ? t("ai:filePicker.currentSpace", { name: spaceName })
                      : spaceName}
                  </span>
                  <span className="h-px min-w-4 flex-1 bg-border/50" />
                </div>
                {group.files.map((file, fileIndex) => {
                  const index = startIndex + fileIndex;
                  const directory = absoluteParentDirectory(file.path);
                  return (
                    <button
                      key={file.path}
                      ref={(el) => {
                        itemRefs.current[index] = el;
                      }}
                      type="button"
                      onClick={() => onPick(file.path)}
                      onMouseEnter={() => onHover(index)}
                      className={cn(
                        "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
                        index === activeIndex
                          ? "bg-interactive-active"
                          : "hover:bg-interactive-hover",
                      )}
                    >
                      <img
                        src={fileIconUrl(file.name)}
                        alt=""
                        className="file-type-icon size-4 shrink-0"
                      />
                      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="truncate font-medium">
                          {file.name}
                        </span>
                        {directory && (
                          <span className="truncate text-[10.5px] text-muted-foreground">
                            {directory}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </PopoverContent>
  );
}

function absoluteParentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return "";
  if (slash === 0) return "/";
  if (slash === 2 && /^[A-Za-z]:/.test(normalized)) {
    return normalized.slice(0, 3);
  }
  return normalized.slice(0, slash);
}
