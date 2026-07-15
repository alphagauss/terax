import { cn } from "@/lib/utils";
import {
  captureRenderedAnchor,
  type MarkdownAnchor,
  restoreRenderedAnchor,
} from "@/modules/markdown/lib/anchor";
import {
  findBlockIndexForSourceLine,
  type MarkdownDocument,
  type MarkdownDocumentHeading,
  prepareMarkdownDocument,
} from "@/modules/markdown/lib/document";
import {
  MarkdownDocumentRenderer,
  type MarkdownDocumentRendererHandle,
} from "@/modules/markdown/MarkdownDocumentRenderer";
import { MarkdownOutlinePanel } from "@/modules/markdown/MarkdownOutlinePanel";
import { MarkdownOutlineToggle } from "@/modules/markdown/MarkdownOutlineToggle";
import { MarkdownSplitLayout } from "@/modules/markdown/MarkdownSplitLayout";
import { MarkdownViewToggle } from "@/modules/markdown/MarkdownViewToggle";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Status =
  | { kind: "loading" }
  | { kind: "ready"; document: MarkdownDocument }
  | { kind: "binary" }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type Props = {
  path: string;
  visible: boolean;
  onSetView: (mode: "rendered" | "raw", anchor: MarkdownAnchor | null) => void;
  restoreAnchor?: MarkdownAnchor | null;
};

const NAVIGATION_FRAME_LIMIT = 30;

export function MarkdownPreviewPane({
  path,
  visible,
  onSetView,
  restoreAnchor,
}: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineAvailable, setOutlineAvailable] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MarkdownDocumentRendererHandle>(null);
  const restoredAnchorRef = useRef<MarkdownAnchor | null>(null);
  const resizeAnchorRef = useRef<MarkdownAnchor | null>(null);
  const navigationFrameRef = useRef(0);
  const outlineId = `${useId()}-markdown-outline`;

  const cancelPendingNavigation = useCallback(() => {
    if (navigationFrameRef.current === 0) return;
    cancelAnimationFrame(navigationFrameRef.current);
    navigationFrameRef.current = 0;
  }, []);

  useEffect(() => {
    let cancelled = false;
    cancelPendingNavigation();
    restoredAnchorRef.current = null;
    setStatus({ kind: "loading" });
    setOutlineOpen(false);
    setOutlineAvailable(true);

    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .then((result) => {
        if (cancelled) return;
        if (result.kind === "text") {
          setStatus({
            kind: "ready",
            document: prepareMarkdownDocument(result.content),
          });
        } else if (result.kind === "binary") {
          setStatus({ kind: "binary" });
        } else {
          setStatus({
            kind: "toolarge",
            size: result.size,
            limit: result.limit,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus({ kind: "error", message: String(error) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cancelPendingNavigation, path]);

  useEffect(
    () => () => {
      cancelPendingNavigation();
    },
    [cancelPendingNavigation],
  );

  const anchorRoot = useCallback(
    (anchor: MarkdownAnchor): ParentNode | null => {
      const content = contentRef.current;
      if (!content || anchor.blockIndex === undefined) return content;
      return (
        rendererRef.current?.findBlockElement(anchor.blockIndex) ??
        content.querySelector<HTMLElement>(
          `[data-markdown-block-mounted][data-markdown-block-index="${anchor.blockIndex}"]`,
        ) ??
        content
      );
    },
    [],
  );

  const scheduleAnchorRestore = useCallback(
    (anchor: MarkdownAnchor) => {
      cancelPendingNavigation();
      navigationFrameRef.current = requestAnimationFrame(() => {
        navigationFrameRef.current = 0;
        const container = scrollRef.current;
        const root = anchorRoot(anchor);
        if (container && root) restoreRenderedAnchor(container, anchor, root);
      });
    },
    [anchorRoot, cancelPendingNavigation],
  );

  const handleOutlineOpenChange = useCallback(
    (open: boolean) => {
      if (open === outlineOpen) return;
      const container = scrollRef.current;
      const anchor = container ? captureRenderedAnchor(container) : null;
      setOutlineOpen(open);
      if (anchor) scheduleAnchorRestore(anchor);
    },
    [outlineOpen, scheduleAnchorRestore],
  );

  const captureResizeAnchor = useCallback(() => {
    const container = scrollRef.current;
    resizeAnchorRef.current = container
      ? captureRenderedAnchor(container)
      : null;
  }, []);

  const restoreResizeAnchor = useCallback(() => {
    const anchor = resizeAnchorRef.current;
    resizeAnchorRef.current = null;
    if (anchor) scheduleAnchorRestore(anchor);
  }, [scheduleAnchorRestore]);

  useEffect(() => {
    if (!outlineOpen || !visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleOutlineOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleOutlineOpenChange, outlineOpen, visible]);

  useEffect(() => {
    const container = scrollRef.current;
    if (
      !container ||
      status.kind !== "ready" ||
      !restoreAnchor ||
      restoredAnchorRef.current === restoreAnchor
    ) {
      return;
    }

    cancelPendingNavigation();
    const renderer = rendererRef.current;
    const sourceLine = restoreAnchor.sourceLine;
    const blockIndex =
      sourceLine === undefined
        ? -1
        : findBlockIndexForSourceLine(status.document.blocks, sourceLine);
    if (blockIndex >= 0) renderer?.ensureBlock(blockIndex);

    let attempts = 0;
    const restore = () => {
      const currentRenderer = rendererRef.current;
      const ready =
        blockIndex < 0 ||
        (currentRenderer !== null &&
          (!currentRenderer.progressive ||
            (currentRenderer.isBlockMounted(blockIndex) &&
              currentRenderer.findBlockElement(blockIndex) !== null)));
      if (ready || attempts >= NAVIGATION_FRAME_LIMIT) {
        navigationFrameRef.current = 0;
        restoredAnchorRef.current = restoreAnchor;
        restoreRenderedAnchor(
          container,
          restoreAnchor,
          anchorRoot({ ...restoreAnchor, blockIndex }) ?? container,
        );
        return;
      }
      attempts += 1;
      navigationFrameRef.current = requestAnimationFrame(restore);
    };
    navigationFrameRef.current = requestAnimationFrame(restore);

    return cancelPendingNavigation;
  }, [anchorRoot, cancelPendingNavigation, restoreAnchor, status]);

  const scrollToHeading = useCallback(
    (item: MarkdownDocumentHeading) => {
      const container = scrollRef.current;
      const content = contentRef.current;
      if (!container || !content) return;
      cancelPendingNavigation();
      rendererRef.current?.ensureBlock(item.blockIndex);

      let attempts = 0;
      const reveal = () => {
        const heading =
          rendererRef.current?.findHeadingElement(item.id) ??
          content.querySelector<HTMLElement>(
            `[data-markdown-heading-id="${item.id}"]`,
          );
        if (heading) {
          navigationFrameRef.current = 0;
          const containerTop = container.getBoundingClientRect().top;
          container.scrollTop +=
            heading.getBoundingClientRect().top - containerTop - 20;
          return;
        }
        if (attempts >= NAVIGATION_FRAME_LIMIT) {
          navigationFrameRef.current = 0;
          return;
        }
        attempts += 1;
        navigationFrameRef.current = requestAnimationFrame(reveal);
      };
      navigationFrameRef.current = requestAnimationFrame(reveal);
    },
    [cancelPendingNavigation],
  );

  const document = status.kind === "ready" ? status.document : null;
  const hasOutline = Boolean(document?.outline.length);
  const scrollContainer = scrollRef.current;

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden rounded-md bg-background",
        !visible && "pointer-events-none",
      )}
    >
      <MarkdownSplitLayout
        outlineOpen={outlineOpen && hasOutline}
        onOutlineOpenChange={handleOutlineOpenChange}
        onOutlineAvailabilityChange={setOutlineAvailable}
        onOutlineResizeStart={captureResizeAnchor}
        onOutlineWidthChange={restoreResizeAnchor}
        outline={
          document && scrollContainer ? (
            <div id={outlineId} className="h-full min-h-0">
              <MarkdownOutlinePanel
                items={document.outline}
                scrollContainer={scrollContainer}
                onSelect={scrollToHeading}
              />
            </div>
          ) : null
        }
      >
        <div className="relative flex h-full min-w-0 flex-col">
          {hasOutline && (
            <MarkdownOutlineToggle
              expanded={outlineOpen && outlineAvailable}
              disabled={!outlineAvailable}
              controls={outlineId}
              onToggle={() => handleOutlineOpenChange(!outlineOpen)}
            />
          )}
          <MarkdownViewToggle
            mode="rendered"
            onChange={(mode) =>
              onSetView(
                mode,
                scrollRef.current
                  ? captureRenderedAnchor(scrollRef.current)
                  : null,
              )
            }
          />
          <div
            ref={scrollRef}
            className="app-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable]"
          >
            <div
              ref={contentRef}
              className="w-full min-w-0 px-4 pt-12 pb-6 sm:px-8"
            >
              {status.kind === "loading" && (
                <p className="text-[12px] text-muted-foreground">Loading…</p>
              )}
              {status.kind === "error" && (
                <p className="text-[12px] text-destructive">
                  Failed to read file: {status.message}
                </p>
              )}
              {status.kind === "binary" && (
                <p className="text-[12px] text-muted-foreground">
                  Binary file: cannot render as markdown.
                </p>
              )}
              {status.kind === "toolarge" && (
                <p className="text-[12px] text-muted-foreground">
                  File is {status.size} bytes; limit {status.limit}.
                </p>
              )}
              {document && scrollContainer && (
                <MarkdownDocumentRenderer
                  ref={rendererRef}
                  document={document}
                  visible={visible}
                  scrollContainer={scrollContainer}
                />
              )}
            </div>
          </div>
        </div>
      </MarkdownSplitLayout>
    </div>
  );
}
