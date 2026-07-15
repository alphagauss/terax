import { cn } from "@/lib/utils";
import { ListViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  expanded: boolean;
  disabled: boolean;
  controls: string;
  onToggle: () => void;
};

export function MarkdownOutlineToggle({
  expanded,
  disabled,
  controls,
  onToggle,
}: Props) {
  const label = expanded ? "Collapse outline" : "Expand outline";

  return (
    <div className="absolute left-3 top-3 z-20 inline-flex items-center rounded-md border border-border/60 bg-card/85 p-0.5 text-[11px] shadow-sm backdrop-blur">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-controls={controls}
        aria-expanded={expanded}
        aria-label={label}
        title={disabled ? "The document pane is too narrow" : label}
        className={cn(
          "flex size-5 items-center justify-center rounded transition-colors",
          "text-muted-foreground hover:text-foreground",
          expanded && "bg-accent text-foreground",
          disabled &&
            "cursor-not-allowed opacity-40 hover:text-muted-foreground",
        )}
      >
        <HugeiconsIcon icon={ListViewIcon} size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}
