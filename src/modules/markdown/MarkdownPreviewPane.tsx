import { cn } from "@/lib/utils";
import type { EditorPaneHandle } from "@/modules/editor/EditorPane";
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

type ViewMode = "rendered" | "raw";

export type MarkdownPreviewPaneHandle = {
  gotoSourceLine: (sourceLine: number) => void;
};

type Props = {
  id: number;
  path: string;
  visible: boolean;
  dirty: boolean;
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
  dirty,
  registerEditorHandle,
  registerNavigationHandle,
  onDirtyChange,
  onCloseTab,
}: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [viewMode, setViewMode] = useState<ViewMode>("rendered");
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
  const loadVersionRef = useRef(0);
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

  const cancelPendingNavigation = useCallback(() => {
    if (navigationFrameRef.current === 0) return;
    cancelAnimationFrame(navigationFrameRef.current);
    navigationFrameRef.current = 0;
  }, []);

  const loadDocument = useCallback(
    async (showLoading: boolean) => {
      const version = ++loadVersionRef.current;
      if (showLoading) setStatus({ kind: "loading" });
      try {
        const result = await invoke<ReadResult>("fs_read_file", {
          path,
          workspace: currentWorkspaceEnv(),
        });
        if (version !== loadVersionRef.current) return;
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
      } catch (error) {
        if (version === loadVersionRef.current) {
          setStatus({ kind: "error", message: String(error) });
        }
      }
    },
    [path],
  );

  useEffect(() => {
    cancelPendingNavigation();
    setActiveOutlineId(null);
    void loadDocument(true);
    return () => {
      loadVersionRef.current += 1;
    };
  }, [cancelPendingNavigation, loadDocument]);

  useEffect(
    () => () => {
      cancelPendingNavigation();
    },
    [cancelPendingNavigation],
  );

  const document = status.kind === "ready" ? status.document : null;
  const hasOutline = Boolean(document?.outline.length);

  useEffect(() => {
    if (viewMode !== "rendered" || !scrollContainer || !document) return;
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
  }, [document, scrollContainer, viewMode]);

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
      void loadDocument(false).then(() => requestRenderedRestore(sourceLine));
    },
    [dirty, loadDocument, requestRenderedRestore, viewMode],
  );

  const handleEditorRef = useCallback(
    (handle: EditorPaneHandle | null) => {
      editorRef.current = handle;
      callbackRef.current.registerEditorHandle(id, handle);
    },
    [id],
  );
  const handleDirtyChange = useCallback(
    (nextDirty: boolean) => callbackRef.current.onDirtyChange(id, nextDirty),
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
              initialSourceLine={pendingRawSourceLineRef.current}
              onViewportSourceLineChange={handleRawViewportLine}
              onDirtyChange={handleDirtyChange}
              onSaved={() => void loadDocument(false)}
              onClose={handleClose}
            />
          ) : (
            <div
              ref={handleScrollRef}
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
          )}
        </div>
      </MarkdownSplitLayout>
    </div>
  );
}
