import { cn } from "@/lib/utils";
import {
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

const OUTLINE_DEFAULT_WIDTH = 240;
const OUTLINE_MIN_WIDTH = 180;
const OUTLINE_MAX_WIDTH = 360;
const CONTENT_MIN_WIDTH = 320;
const SEPARATOR_WIDTH = 1;
const KEYBOARD_STEP = 10;

type Props = {
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

function outlineAvailable(containerWidth: number): boolean {
  return (
    containerWidth === 0 ||
    containerWidth >= OUTLINE_MIN_WIDTH + CONTENT_MIN_WIDTH + SEPARATOR_WIDTH
  );
}

function maximumOutlineWidth(containerWidth: number): number {
  if (containerWidth === 0) return OUTLINE_MAX_WIDTH;
  return clamp(
    containerWidth - CONTENT_MIN_WIDTH - SEPARATOR_WIDTH,
    OUTLINE_MIN_WIDTH,
    OUTLINE_MAX_WIDTH,
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
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLHRElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [outlineWidth, setOutlineWidth] = useState(OUTLINE_DEFAULT_WIDTH);
  const outlineId = `${useId()}-outline`;
  const available = outlineAvailable(containerWidth);
  const open = outlineOpen && available;
  const maximumWidth = maximumOutlineWidth(containerWidth);
  const renderedWidth = clamp(outlineWidth, OUTLINE_MIN_WIDTH, maximumWidth);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = (width: number) => setContainerWidth(width);
    update(container.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) update(width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    onOutlineAvailabilityChange?.(available);
  }, [available, onOutlineAvailabilityChange]);

  useEffect(() => {
    if (outlineOpen && !available) onOutlineOpenChange(false);
  }, [available, onOutlineOpenChange, outlineOpen]);

  const showGuide = useCallback((width: number) => {
    const guide = guideRef.current;
    if (!guide) return;
    guide.style.transform = `translateX(${width}px)`;
    guide.style.opacity = "1";
  }, []);

  const hideGuide = useCallback(() => {
    if (guideRef.current) guideRef.current.style.opacity = "0";
    delete separatorRef.current?.dataset.dragging;
  }, []);

  const commitWidth = useCallback(
    (width: number) => {
      const nextWidth = clamp(
        width,
        OUTLINE_MIN_WIDTH,
        maximumOutlineWidth(containerRef.current?.clientWidth ?? 0),
      );
      setOutlineWidth(nextWidth);
      onOutlineWidthChange?.(nextWidth);
    },
    [onOutlineWidthChange],
  );

  const updateDrag = useCallback(
    (event: PointerEvent<HTMLHRElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.nextWidth = clamp(
        drag.startWidth + event.clientX - drag.startX,
        OUTLINE_MIN_WIDTH,
        maximumOutlineWidth(containerRef.current?.clientWidth ?? 0),
      );
      showGuide(drag.nextWidth);
    },
    [showGuide],
  );

  const finishDrag = useCallback(
    (pointerId: number, commit: boolean) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;
      dragRef.current = null;
      hideGuide();
      if (commit) commitWidth(drag.nextWidth);
    },
    [commitWidth, hideGuide],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLHRElement>) => {
      if (event.button !== 0 || !event.isPrimary || !available) return;
      event.preventDefault();
      onOutlineResizeStart?.();
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: renderedWidth,
        nextWidth: renderedWidth,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dragging = "true";
      showGuide(renderedWidth);
    },
    [available, onOutlineResizeStart, renderedWidth, showGuide],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLHRElement>) => {
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") nextWidth = renderedWidth - KEYBOARD_STEP;
      else if (event.key === "ArrowRight") {
        nextWidth = renderedWidth + KEYBOARD_STEP;
      } else if (event.key === "Home") nextWidth = OUTLINE_MIN_WIDTH;
      else if (event.key === "End") nextWidth = maximumWidth;
      if (nextWidth === null) return;
      event.preventDefault();
      onOutlineResizeStart?.();
      commitWidth(nextWidth);
    },
    [commitWidth, maximumWidth, onOutlineResizeStart, renderedWidth],
  );

  return (
    <div
      ref={containerRef}
      data-markdown-split-layout
      className={cn(
        "relative flex h-full min-h-0 w-full min-w-0 overflow-hidden",
        className,
      )}
    >
      {open && (
        <aside
          id={outlineId}
          className="h-full min-h-0 shrink-0 overflow-hidden"
          style={{ width: renderedWidth }}
        >
          {outline}
        </aside>
      )}

      {open && (
        <hr
          ref={separatorRef}
          tabIndex={0}
          aria-label={separatorLabel}
          aria-controls={outlineId}
          aria-orientation="vertical"
          aria-valuemin={OUTLINE_MIN_WIDTH}
          aria-valuemax={maximumWidth}
          aria-valuenow={Math.round(renderedWidth)}
          aria-valuetext={`${Math.round(renderedWidth)} pixels`}
          data-markdown-outline-separator
          className={cn(
            "relative z-20 m-0 h-full w-px shrink-0 cursor-col-resize touch-none border-0 bg-border p-0",
            "after:absolute after:inset-y-0 after:-left-1 after:w-3 after:content-['']",
            "focus-visible:bg-ring focus-visible:outline-none",
            "data-[dragging=true]:bg-primary/60",
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={updateDrag}
          onPointerUp={(event) => {
            updateDrag(event);
            finishDrag(event.pointerId, true);
          }}
          onPointerCancel={(event) => finishDrag(event.pointerId, false)}
          onLostPointerCapture={(event) => finishDrag(event.pointerId, false)}
          onKeyDown={handleKeyDown}
        />
      )}

      <main className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
        {children}
      </main>

      <div
        ref={guideRef}
        aria-hidden
        data-markdown-outline-resize-preview
        className="pointer-events-none absolute inset-y-0 left-0 z-30 w-px bg-primary opacity-0 shadow-[0_0_6px_var(--color-primary)] will-change-transform"
      />
    </div>
  );
}
