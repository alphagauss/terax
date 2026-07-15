import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

const MARKDOWN_OUTLINE_DEFAULT_WIDTH = 240;
const MARKDOWN_OUTLINE_MIN_WIDTH = 180;
const MARKDOWN_OUTLINE_MAX_WIDTH = 360;
const MARKDOWN_CONTENT_MIN_WIDTH = 320;

const SEPARATOR_WIDTH = 1;
const KEYBOARD_RESIZE_STEP = 10;

type MarkdownSplitLayoutProps = {
  outlineOpen: boolean;
  onOutlineOpenChange: (open: boolean) => void;
  outline: ReactNode;
  children: ReactNode;
  className?: string;
  separatorLabel?: string;
  onOutlineAvailabilityChange?: (available: boolean) => void;
  onOutlineResizeStart?: () => void;
  onOutlineWidthChange?: (width: number) => void;
};

type DragState = {
  pointerId: number;
  startX: number;
  startWidth: number;
  nextWidth: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function canFitOutline(containerWidth: number | null): boolean {
  return (
    containerWidth === null ||
    containerWidth <= 0 ||
    containerWidth >=
      MARKDOWN_OUTLINE_MIN_WIDTH + MARKDOWN_CONTENT_MIN_WIDTH + SEPARATOR_WIDTH
  );
}

function maxOutlineWidth(containerWidth: number | null): number {
  if (containerWidth === null || containerWidth <= 0) {
    return MARKDOWN_OUTLINE_MAX_WIDTH;
  }
  return clamp(
    containerWidth - MARKDOWN_CONTENT_MIN_WIDTH - SEPARATOR_WIDTH,
    MARKDOWN_OUTLINE_MIN_WIDTH,
    MARKDOWN_OUTLINE_MAX_WIDTH,
  );
}

export function MarkdownSplitLayout({
  outlineOpen,
  onOutlineOpenChange,
  outline,
  children,
  className,
  separatorLabel = "Resize document outline",
  onOutlineAvailabilityChange,
  onOutlineResizeStart,
  onOutlineWidthChange,
}: MarkdownSplitLayoutProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLHRElement>(null);
  const outlinePanelRef = useRef<PanelImperativeHandle>(null);
  const preferredOutlineWidthRef = useRef(MARKDOWN_OUTLINE_DEFAULT_WIDTH);
  const groupWidthRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const unavailableCloseNotifiedRef = useRef(false);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [renderedOutlineWidth, setRenderedOutlineWidth] = useState(
    MARKDOWN_OUTLINE_DEFAULT_WIDTH,
  );
  const layoutId = useId();
  const outlinePanelId = `${layoutId}-outline`;
  const contentPanelId = `${layoutId}-content`;
  const outlineAvailable = canFitOutline(containerWidth);
  const effectiveOutlineOpen = outlineOpen && outlineAvailable;
  const maximumOutlineWidth = maxOutlineWidth(containerWidth);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const updateWidth = (width: number) => {
      groupWidthRef.current = width;
      setContainerWidth((current) =>
        current !== null && Math.abs(current - width) < 0.5 ? current : width,
      );
    };
    updateWidth(group.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateWidth(entry.contentRect.width);
    });
    observer.observe(group);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    onOutlineAvailabilityChange?.(outlineAvailable);
  }, [onOutlineAvailabilityChange, outlineAvailable]);

  useEffect(() => {
    if (outlineOpen && !outlineAvailable) {
      if (!unavailableCloseNotifiedRef.current) {
        unavailableCloseNotifiedRef.current = true;
        onOutlineOpenChange(false);
      }
      return;
    }
    unavailableCloseNotifiedRef.current = false;
  }, [onOutlineOpenChange, outlineAvailable, outlineOpen]);

  useLayoutEffect(() => {
    const outlinePanel = outlinePanelRef.current;
    if (!outlinePanel) return;
    if (!effectiveOutlineOpen) {
      outlinePanel.collapse();
      return;
    }

    const nextWidth = clamp(
      preferredOutlineWidthRef.current,
      MARKDOWN_OUTLINE_MIN_WIDTH,
      maximumOutlineWidth,
    );
    outlinePanel.resize(`${nextWidth}px`);
  }, [effectiveOutlineOpen, maximumOutlineWidth]);

  const resetGhost = useCallback(() => {
    const separator = separatorRef.current;
    const currentWidth =
      outlinePanelRef.current?.getSize().inPixels || renderedOutlineWidth;
    if (separator) {
      delete separator.dataset.dragging;
      separator.setAttribute("aria-valuenow", String(Math.round(currentWidth)));
      separator.setAttribute(
        "aria-valuetext",
        `${Math.round(currentWidth)} pixels`,
      );
      separator.style.setProperty("--markdown-outline-preview-x", "0px");
    }
  }, [renderedOutlineWidth]);

  const commitOutlineWidth = useCallback(
    (width: number) => {
      const outlinePanel = outlinePanelRef.current;
      if (!outlinePanel || !canFitOutline(groupWidthRef.current)) return;
      const nextWidth = clamp(
        width,
        MARKDOWN_OUTLINE_MIN_WIDTH,
        maxOutlineWidth(groupWidthRef.current),
      );
      preferredOutlineWidthRef.current = nextWidth;
      outlinePanel.resize(`${nextWidth}px`);
      setRenderedOutlineWidth(nextWidth);
      onOutlineWidthChange?.(nextWidth);
    },
    [onOutlineWidthChange],
  );

  const updateDrag = useCallback((event: PointerEvent<HTMLHRElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextWidth = clamp(
      drag.startWidth + event.clientX - drag.startX,
      MARKDOWN_OUTLINE_MIN_WIDTH,
      maxOutlineWidth(groupWidthRef.current),
    );
    drag.nextWidth = nextWidth;
    separatorRef.current?.setAttribute(
      "aria-valuenow",
      String(Math.round(nextWidth)),
    );
    separatorRef.current?.setAttribute(
      "aria-valuetext",
      `${Math.round(nextWidth)} pixels`,
    );
    separatorRef.current?.style.setProperty(
      "--markdown-outline-preview-x",
      `${nextWidth - drag.startWidth}px`,
    );
  }, []);

  const finishDrag = useCallback(
    (commit: boolean, pointerId: number) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;
      dragRef.current = null;
      resetGhost();
      if (commit) commitOutlineWidth(drag.nextWidth);
    },
    [commitOutlineWidth, resetGhost],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLHRElement>) => {
      const outlinePanel = outlinePanelRef.current;
      if (
        event.button !== 0 ||
        !event.isPrimary ||
        !outlinePanel ||
        !outlineAvailable
      ) {
        return;
      }
      event.preventDefault();
      onOutlineResizeStart?.();
      const startWidth = clamp(
        outlinePanel.getSize().inPixels || preferredOutlineWidthRef.current,
        MARKDOWN_OUTLINE_MIN_WIDTH,
        maximumOutlineWidth,
      );
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth,
        nextWidth: startWidth,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dragging = "true";
    },
    [maximumOutlineWidth, onOutlineResizeStart, outlineAvailable],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLHRElement>) => {
      let nextWidth: number | null = null;
      const currentWidth =
        outlinePanelRef.current?.getSize().inPixels || renderedOutlineWidth;
      switch (event.key) {
        case "ArrowLeft":
          nextWidth = currentWidth - KEYBOARD_RESIZE_STEP;
          break;
        case "ArrowRight":
          nextWidth = currentWidth + KEYBOARD_RESIZE_STEP;
          break;
        case "Home":
          nextWidth = MARKDOWN_OUTLINE_MIN_WIDTH;
          break;
        case "End":
          nextWidth = maximumOutlineWidth;
          break;
      }
      if (nextWidth === null) return;
      event.preventDefault();
      onOutlineResizeStart?.();
      commitOutlineWidth(nextWidth);
    },
    [
      commitOutlineWidth,
      maximumOutlineWidth,
      onOutlineResizeStart,
      renderedOutlineWidth,
    ],
  );

  return (
    <ResizablePanelGroup
      elementRef={groupRef}
      orientation="horizontal"
      disabled
      disableCursor
      data-markdown-split-layout
      className={cn("relative h-full min-h-0 w-full min-w-0", className)}
    >
      <ResizablePanel
        id={outlinePanelId}
        panelRef={outlinePanelRef}
        defaultSize="0px"
        minSize={`${MARKDOWN_OUTLINE_MIN_WIDTH}px`}
        maxSize={`${maximumOutlineWidth}px`}
        collapsedSize="0px"
        collapsible
        groupResizeBehavior="preserve-pixel-size"
        aria-hidden={!effectiveOutlineOpen}
        inert={!effectiveOutlineOpen}
        style={{ overflow: "hidden" }}
        onResize={(size) => {
          if (size.inPixels > 0) setRenderedOutlineWidth(size.inPixels);
        }}
      >
        <div className="h-full min-h-0 min-w-0 overflow-hidden">
          {effectiveOutlineOpen ? outline : null}
        </div>
      </ResizablePanel>

      {effectiveOutlineOpen && (
        <hr
          ref={separatorRef}
          tabIndex={0}
          aria-label={separatorLabel}
          aria-controls={outlinePanelId}
          aria-orientation="vertical"
          aria-valuemin={MARKDOWN_OUTLINE_MIN_WIDTH}
          aria-valuemax={maximumOutlineWidth}
          aria-valuenow={Math.round(renderedOutlineWidth)}
          aria-valuetext={`${Math.round(renderedOutlineWidth)} pixels`}
          data-markdown-outline-separator
          className={cn(
            "relative z-20 m-0 h-full w-px shrink-0 cursor-col-resize touch-none border-0 bg-border p-0",
            "after:absolute after:inset-y-0 after:-left-1 after:w-3 after:content-['']",
            "before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-px before:translate-x-[var(--markdown-outline-preview-x)] before:bg-primary before:opacity-0 before:will-change-transform before:content-['']",
            "focus-visible:bg-ring focus-visible:outline-none",
            "data-[dragging=true]:bg-primary/60 data-[dragging=true]:before:opacity-100",
          )}
          style={
            {
              "--markdown-outline-preview-x": "0px",
            } as CSSProperties
          }
          onPointerDown={handlePointerDown}
          onPointerMove={updateDrag}
          onPointerUp={(event) => {
            updateDrag(event);
            finishDrag(true, event.pointerId);
          }}
          onPointerCancel={(event) => finishDrag(false, event.pointerId)}
          onLostPointerCapture={(event) => finishDrag(false, event.pointerId)}
          onKeyDown={handleKeyDown}
          data-markdown-outline-resize-preview
        />
      )}

      <ResizablePanel
        id={contentPanelId}
        minSize={`${MARKDOWN_CONTENT_MIN_WIDTH}px`}
        groupResizeBehavior="preserve-relative-size"
        style={{ overflow: "hidden" }}
      >
        <div className="h-full min-h-0 min-w-0 overflow-hidden">{children}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
