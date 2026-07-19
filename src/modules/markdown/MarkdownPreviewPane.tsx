import { cn } from "@/lib/utils";
import type { EditorPaneHandle } from "@/modules/editor/EditorPane";
import { useDocument } from "@/modules/editor/lib/useDocument";
import {
  MARKDOWN_ACTIVATION_OFFSET,
  MARKDOWN_CONTENT_CHANGE_EVENT,
  readActiveRenderedHeadingId,
  readRenderedViewportSourceLine,
  restoreRenderedSourceLine,
} from "@/modules/markdown/lib/anchor";
import {
  findBlockIndexForSourceLine,
  type MarkdownDocument,
  type MarkdownDocumentHeading,
  prepareMarkdownDocument,
} from "@/modules/markdown/lib/document";
import { findActiveOutlineId } from "@/modules/markdown/lib/outline";
import {
  MarkdownDocumentRenderer,
  type MarkdownDocumentRendererHandle,
} from "@/modules/markdown/MarkdownDocumentRenderer";
import { MarkdownOutlinePanel } from "@/modules/markdown/MarkdownOutlinePanel";
import { MarkdownOutlineToggle } from "@/modules/markdown/MarkdownOutlineToggle";
import { MarkdownRawPane } from "@/modules/markdown/MarkdownRawPane";
import { MarkdownSplitLayout } from "@/modules/markdown/MarkdownSplitLayout";
import { MarkdownViewToggle } from "@/modules/markdown/MarkdownViewToggle";
import { useCallback, useEffect, useId, useRef, useState } from "react";

type ViewMode = "rendered" | "raw";

export type MarkdownPreviewPaneHandle = {
  gotoSourceLine: (sourceLine: number) => void;
};

type Props = {
  id: number;
  path: string;
  visible: boolean;
  focused: boolean;
  registerEditorHandle: (id: number, handle: EditorPaneHandle | null) => void;
  registerNavigationHandle: (
    id: number,
    handle: MarkdownPreviewPaneHandle | null,
  ) => void;
  onDirtyChange: (id: number, dirty: boolean) => void;
  onCloseTab: (id: number) => void;
};

const NAVIGATION_FRAME_LIMIT = 30;

export function MarkdownPreviewPane({
  id,
  path,
  visible,
  focused,
  registerEditorHandle,
  registerNavigationHandle,
  onDirtyChange,
  onCloseTab,
}: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("rendered");
  const [preparedDocument, setPreparedDocument] = useState<{
    path: string;
    content: string;
    document: MarkdownDocument;
  } | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineAvailable, setOutlineAvailable] = useState(true);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [renderedRestore, setRenderedRestore] = useState<{
    sourceLine: number;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MarkdownDocumentRendererHandle>(null);
  const editorRef = useRef<EditorPaneHandle>(null);
  const navigationFrameRef = useRef(0);
  const pendingRawSourceLineRef = useRef<number | null>(null);
  const resizeSourceLineRef = useRef<number | null>(null);
  const navigationTargetRef = useRef<(sourceLine: number) => void>(() => {});
  const callbackRef = useRef({
    registerEditorHandle,
    onDirtyChange,
    onCloseTab,
  });
  callbackRef.current = { registerEditorHandle, onDirtyChange, onCloseTab };
  const outlineId = `${useId()}-markdown-outline`;
  const handleDirtyChange = useCallback(
    (nextDirty: boolean) => callbackRef.current.onDirtyChange(id, nextDirty),
    [id],
  );
  const { doc, dirty } = useDocument({
    path,
    onDirtyChange: handleDirtyChange,
  });

  const cancelPendingNavigation = useCallback(() => {
    if (navigationFrameRef.current === 0) return;
    cancelAnimationFrame(navigationFrameRef.current);
    navigationFrameRef.current = 0;
  }, []);

  useEffect(() => {
    void path;
    cancelPendingNavigation();
    setActiveOutlineId(null);
  }, [cancelPendingNavigation, path]);

  useEffect(
    () => () => {
      cancelPendingNavigation();
    },
    [cancelPendingNavigation],
  );

  useEffect(() => {
    if (doc.status !== "ready" || !visible || viewMode !== "rendered") return;
    setPreparedDocument((current) =>
      current?.path === path && current.content === doc.content
        ? current
        : {
            path,
            content: doc.content,
            document: prepareMarkdownDocument(doc.content),
          },
    );
  }, [doc, path, viewMode, visible]);
  const document =
    doc.status === "ready" && preparedDocument?.path === path
      ? preparedDocument.document
      : null;
  const hasOutline = Boolean(document?.outline.length);

  useEffect(() => {
    if (!visible || viewMode !== "rendered" || !scrollContainer || !document) {
      return;
    }
    let frame = 0;
    const updateActiveHeading = () => {
      frame = 0;
      const sourceLine = readRenderedViewportSourceLine(scrollContainer);
      const active =
        sourceLine === undefined
          ? readActiveRenderedHeadingId(scrollContainer)
          : findActiveOutlineId(document.outline, sourceLine);
      setActiveOutlineId((current) => (current === active ? current : active));
    };
    const scheduleUpdate = () => {
      if (frame === 0) frame = requestAnimationFrame(updateActiveHeading);
    };

    updateActiveHeading();
    scrollContainer.addEventListener("scroll", scheduleUpdate, {
      passive: true,
    });
    scrollContainer.addEventListener(
      MARKDOWN_CONTENT_CHANGE_EVENT,
      scheduleUpdate,
    );
    return () => {
      scrollContainer.removeEventListener("scroll", scheduleUpdate);
      scrollContainer.removeEventListener(
        MARKDOWN_CONTENT_CHANGE_EVENT,
        scheduleUpdate,
      );
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [document, scrollContainer, viewMode, visible]);

  const requestRenderedRestore = useCallback((sourceLine: number | null) => {
    if (sourceLine == null) return;
    setRenderedRestore({ sourceLine });
  }, []);

  useEffect(() => {
    const sourceLine = renderedRestore?.sourceLine;
    if (
      viewMode !== "rendered" ||
      sourceLine == null ||
      !scrollContainer ||
      !document
    ) {
      return;
    }

    cancelPendingNavigation();
    const blockIndex = findBlockIndexForSourceLine(document.blocks, sourceLine);
    if (blockIndex >= 0) rendererRef.current?.ensureBlock(blockIndex);
    let attempts = 0;
    const restore = () => {
      const root =
        (blockIndex >= 0
          ? rendererRef.current?.findBlockElement(blockIndex)
          : null) ?? contentRef.current;
      if (
        (root &&
          restoreRenderedSourceLine(scrollContainer, sourceLine, root)) ||
        attempts >= NAVIGATION_FRAME_LIMIT
      ) {
        navigationFrameRef.current = 0;
        setRenderedRestore(null);
        return;
      }
      attempts += 1;
      navigationFrameRef.current = requestAnimationFrame(restore);
    };
    navigationFrameRef.current = requestAnimationFrame(restore);
    return cancelPendingNavigation;
  }, [
    cancelPendingNavigation,
    document,
    renderedRestore,
    scrollContainer,
    viewMode,
  ]);

  const handleOutlineOpenChange = useCallback(
    (open: boolean) => {
      if (open === outlineOpen) return;
      const sourceLine = scrollRef.current
        ? readRenderedViewportSourceLine(scrollRef.current)
        : null;
      setOutlineOpen(open);
      requestRenderedRestore(sourceLine ?? null);
    },
    [outlineOpen, requestRenderedRestore],
  );

  useEffect(() => {
    if (!outlineOpen || !visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleOutlineOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleOutlineOpenChange, outlineOpen, visible]);

  const scrollToHeading = useCallback(
    (item: MarkdownDocumentHeading) => {
      setActiveOutlineId(item.id);
      if (viewMode === "raw") {
        editorRef.current?.scrollToSourceLine(item.sourceLine);
        return;
      }

      const container = scrollRef.current;
      const content = contentRef.current;
      if (!container || !content) return;
      cancelPendingNavigation();
      rendererRef.current?.ensureBlock(item.blockIndex);
      let attempts = 0;
      const reveal = () => {
        const heading = content.querySelector<HTMLElement>(
          `[data-markdown-heading-id="${item.id}"]`,
        );
        if (heading) {
          navigationFrameRef.current = 0;
          container.scrollTop +=
            heading.getBoundingClientRect().top -
            container.getBoundingClientRect().top -
            MARKDOWN_ACTIVATION_OFFSET;
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
    [cancelPendingNavigation, viewMode],
  );

  const handleViewChange = useCallback(
    (mode: ViewMode) => {
      if (mode === viewMode || (mode === "rendered" && dirty)) return;
      if (mode === "raw") {
        pendingRawSourceLineRef.current = scrollRef.current
          ? (readRenderedViewportSourceLine(scrollRef.current) ?? null)
          : null;
        setViewMode("raw");
        return;
      }

      const sourceLine = editorRef.current?.getViewportSourceLine() ?? null;
      setViewMode("rendered");
      requestRenderedRestore(sourceLine);
    },
    [dirty, requestRenderedRestore, viewMode],
  );

  const handleEditorRef = useCallback(
    (handle: EditorPaneHandle | null) => {
      editorRef.current = handle;
      callbackRef.current.registerEditorHandle(id, handle);
    },
    [id],
  );
  const handleClose = useCallback(
    () => callbackRef.current.onCloseTab(id),
    [id],
  );
  const handleRawViewportLine = useCallback(
    (sourceLine: number) => {
      if (!document) return;
      const active = findActiveOutlineId(document.outline, sourceLine);
      setActiveOutlineId((current) => (current === active ? current : active));
    },
    [document],
  );
  useEffect(() => {
    if (viewMode !== "raw" || !document) return;
    const sourceLine = editorRef.current?.getViewportSourceLine();
    if (sourceLine != null) handleRawViewportLine(sourceLine);
  }, [document, handleRawViewportLine, viewMode]);

  navigationTargetRef.current = (sourceLine) => {
    const active = document
      ? findActiveOutlineId(document.outline, sourceLine)
      : null;
    setActiveOutlineId(active);
    if (viewMode === "raw") {
      editorRef.current?.scrollToSourceLine(sourceLine);
    } else {
      requestRenderedRestore(sourceLine);
    }
  };

  useEffect(() => {
    const handle: MarkdownPreviewPaneHandle = {
      gotoSourceLine: (sourceLine) => navigationTargetRef.current(sourceLine),
    };
    registerNavigationHandle(id, handle);
    return () => registerNavigationHandle(id, null);
  }, [id, registerNavigationHandle]);

  const handleScrollRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScrollContainer(node);
  }, []);

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
        onOutlineResizeStart={() => {
          resizeSourceLineRef.current = scrollRef.current
            ? (readRenderedViewportSourceLine(scrollRef.current) ?? null)
            : null;
        }}
        onOutlineWidthChange={() => {
          requestRenderedRestore(resizeSourceLineRef.current);
          resizeSourceLineRef.current = null;
        }}
        outline={
          document ? (
            <div id={outlineId} className="h-full min-h-0">
              <MarkdownOutlinePanel
                items={document.outline}
                activeId={activeOutlineId}
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
            mode={viewMode}
            onChange={handleViewChange}
            renderedDisabled={dirty}
            renderedHint="Save to preview"
          />

          {viewMode === "raw" ? (
            <MarkdownRawPane
              ref={handleEditorRef}
              path={path}
              lspEnabled={focused}
              initialSourceLine={pendingRawSourceLineRef.current}
              onViewportSourceLineChange={handleRawViewportLine}
              onDirtyChange={handleDirtyChange}
              onClose={handleClose}
            />
          ) : (
            <div
              ref={handleScrollRef}
              className="app-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable]"
            >
              <div
                ref={contentRef}
                className="mx-auto w-full min-w-0 max-w-[800px] px-4 pt-12 pb-6 sm:px-[26px]"
              >
                {doc.status === "loading" && (
                  <p className="text-[12px] text-muted-foreground">Loading…</p>
                )}
                {doc.status === "error" && (
                  <p className="text-[12px] text-destructive">
                    Failed to read file: {doc.message}
                  </p>
                )}
                {doc.status === "binary" && (
                  <p className="text-[12px] text-muted-foreground">
                    Binary file: cannot render as markdown.
                  </p>
                )}
                {doc.status === "toolarge" && (
                  <p className="text-[12px] text-muted-foreground">
                    File is {doc.size} bytes; limit {doc.limit}.
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
          )}
        </div>
      </MarkdownSplitLayout>
    </div>
  );
}
