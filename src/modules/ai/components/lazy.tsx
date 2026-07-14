import { lazy, Suspense } from "react";
import type { AgentRunBridgeProps } from "./AgentRunBridge";
import type { SelectionAskAiProps } from "./SelectionAskAi";

const AgentRunBridgeInner = lazy(() =>
  import("./AgentRunBridge").then((m) => ({ default: m.AgentRunBridge })),
);

const AiSidebarPanelInner = lazy(() =>
  import("./AiSidebarPanel").then((m) => ({ default: m.AiSidebarPanel })),
);

const SelectionAskAiInner = lazy(() =>
  import("./SelectionAskAi").then((m) => ({ default: m.SelectionAskAi })),
);

export function AgentRunBridge(props: AgentRunBridgeProps) {
  return (
    <Suspense fallback={null}>
      <AgentRunBridgeInner {...props} />
    </Suspense>
  );
}

export function AiSidebarPanel({
  hasComposer,
  onClose,
}: {
  hasComposer: boolean;
  onClose: () => void;
}) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-sidebar text-xs text-muted-foreground">
          Loading AI…
        </div>
      }
    >
      <AiSidebarPanelInner hasComposer={hasComposer} onClose={onClose} />
    </Suspense>
  );
}

export function SelectionAskAi(props: SelectionAskAiProps) {
  return (
    <Suspense fallback={null}>
      <SelectionAskAiInner {...props} />
    </Suspense>
  );
}
