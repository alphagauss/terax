import { Button } from "@/components/ui/button";
import { Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export function AiInputBarConnect({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="relative z-10 shrink-0 px-3 pt-2 pb-3">
      <div className="flex flex-col items-start gap-2 rounded-2xl border border-border/70 bg-card p-3 text-xs shadow-[0_10px_32px_rgba(0,0,0,0.16),0_2px_8px_rgba(0,0,0,0.08)]">
        <span className="text-muted-foreground">
          Connect any AI provider (or use local models) - your key stays in your
          OS keychain.
        </span>
        <Button size="xs" onClick={onAdd}>
          <HugeiconsIcon icon={Key01Icon} />
          Connect provider
        </Button>
      </div>
    </div>
  );
}
