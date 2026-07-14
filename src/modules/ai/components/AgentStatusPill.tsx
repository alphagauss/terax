import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  AiChat01Icon,
  AlertCircleIcon,
  AlertDiamondIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useChatStore, type AgentMeta } from "../store/chatStore";

type Props = {
  onClick: () => void;
  active?: boolean;
};

export function AgentStatusPill({ onClick, active = false }: Props) {
  const meta = useChatStore((s) => s.agentMeta);
  const { tone, icon, label } = describe(meta);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors",
        tone,
        active &&
          meta.status === "idle" &&
          "border-border bg-accent text-foreground",
      )}
      title={active ? "Close AI sidebar" : "Open AI sidebar"}
      aria-label={active ? "Close AI sidebar" : "Open AI sidebar"}
      aria-pressed={active}
    >
      {icon}
      <span className="max-w-[180px] truncate">{label}</span>
    </button>
  );
}

function describe(meta: AgentMeta): {
  tone: string;
  icon: React.ReactNode;
  label: string;
} {
  if (meta.status === "awaiting-approval") {
    return {
      tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-400",
      icon: (
        <HugeiconsIcon icon={AlertDiamondIcon} size={12} strokeWidth={1.75} />
      ),
      label:
        meta.approvalsPending > 1
          ? `${meta.approvalsPending} approvals`
          : "Approval needed",
    };
  }
  if (meta.status === "error") {
    return {
      tone: "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15",
      icon: (
        <HugeiconsIcon icon={AlertCircleIcon} size={12} strokeWidth={1.75} />
      ),
      label: meta.error ?? "Error",
    };
  }
  if (meta.status === "idle") {
    return {
      tone: "border-transparent text-muted-foreground hover:border-border/60 hover:bg-accent hover:text-foreground",
      icon: <HugeiconsIcon icon={AiChat01Icon} size={12} strokeWidth={1.75} />,
      label: "AI",
    };
  }
  return {
    tone: "border-border/60 bg-card text-muted-foreground hover:text-foreground",
    icon: <Spinner className="size-3" />,
    label: meta.step ?? "Thinking…",
  };
}
