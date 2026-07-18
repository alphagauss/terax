import * as ResizablePrimitive from "react-resizable-panels";

import {
  prefersReducedMotion,
  readMotionDurationMs,
} from "@/lib/motion";
import { cn } from "@/lib/utils";

const layoutAnimationCleanups = new WeakMap<HTMLDivElement, () => void>();

function animateResizableLayout(
  group: HTMLDivElement | null,
  update: () => void,
) {
  if (!group) {
    update();
    return;
  }

  if (prefersReducedMotion()) {
    update();
    return;
  }

  layoutAnimationCleanups.get(group)?.();
  group.dataset.layoutAnimating = "true";
  void group.offsetWidth;

  let timer = 0;
  const cleanup = () => {
    window.clearTimeout(timer);
    group.removeEventListener("transitionend", handleTransitionEnd);
    delete group.dataset.layoutAnimating;
    if (layoutAnimationCleanups.get(group) === cleanup) {
      layoutAnimationCleanups.delete(group);
    }
  };
  const handleTransitionEnd = (event: TransitionEvent) => {
    if (
      event.propertyName === "flex-grow" &&
      event.target instanceof HTMLElement &&
      event.target.dataset.slot === "resizable-panel"
    ) {
      cleanup();
    }
  };

  layoutAnimationCleanups.set(group, cleanup);
  group.addEventListener("transitionend", handleTransitionEnd);
  timer = window.setTimeout(
    cleanup,
    readMotionDurationMs("--dur-pane", 150) + 50,
  );

  try {
    update();
  } catch (error) {
    cleanup();
    throw error;
  }
}

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border/70 ring-offset-background transition-colors duration-feedback after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 hover:bg-primary/45 focus-visible:bg-primary/55 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden data-[separator=active]:bg-primary/60 data-[separator=disabled]:bg-border/40 aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 motion-reduce:transition-none [&[aria-orientation=horizontal]>div]:rotate-90",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  );
}

export {
  animateResizableLayout,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
};
