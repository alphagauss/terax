import { cn } from "@/lib/utils";
import type { MarkdownOutlineItem } from "@/modules/markdown/lib/outline";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";

const OUTLINE_ROW_HEIGHT = 28;

type Props = {
  items: readonly MarkdownOutlineItem[];
  activeId: string | null;
  onSelect: (item: MarkdownOutlineItem) => void;
};

export function MarkdownOutlinePanel({ items, activeId, onSelect }: Props) {
  const navRef = useRef<HTMLElement>(null);
  const baseLevel = useMemo(
    () => items.reduce((lowest, item) => Math.min(lowest, item.level), 6),
    [items],
  );
  const itemIndexById = useMemo(
    () => new Map(items.map((item, index) => [item.id, index])),
    [items],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => navRef.current,
    estimateSize: () => OUTLINE_ROW_HEIGHT,
    overscan: 8,
    paddingStart: 8,
    paddingEnd: 8,
    getItemKey: (index) => items[index]?.id ?? index,
  });

  useEffect(() => {
    if (!activeId) return;
    const index = itemIndexById.get(activeId);
    if (index !== undefined) {
      virtualizer.scrollToIndex(index, { align: "auto" });
    }
  }, [activeId, itemIndexById, virtualizer]);

  return (
    <div
      data-markdown-outline
      className="flex h-full min-h-0 flex-col bg-sidebar"
    >
      <div className="flex h-12 shrink-0 items-center border-b border-border/60 px-3">
        <span className="truncate text-xs font-medium text-foreground">
          Outline
        </span>
      </div>
      <nav
        ref={navRef}
        aria-label="Document headings"
        className="app-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index];
            if (!item) return null;
            return (
              <div
                key={virtualRow.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <button
                  type="button"
                  aria-current={activeId === item.id ? "location" : undefined}
                  onClick={() => onSelect(item)}
                  className={cn(
                    "mx-2 h-7 w-[calc(100%-1rem)] truncate rounded-md pr-2 text-left text-xs leading-7 transition-colors",
                    "hover:bg-muted/70 hover:text-foreground",
                    activeId === item.id
                      ? "bg-accent/70 font-semibold text-foreground"
                      : "font-normal text-muted-foreground",
                  )}
                  style={{
                    paddingLeft: `${8 + (item.level - baseLevel) * 10}px`,
                  }}
                  title={item.title}
                >
                  {item.title}
                </button>
              </div>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
