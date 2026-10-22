/**
 * 本文件实现 Markdown 文档的静态与渐进渲染。
 *
 * 负责延迟挂载长文档块、代码高亮、受控链接和源码位置，不负责文件读取与持久化。
 */

import { Hint } from "@/components/controls/tooltip";
import { FileReferenceLink } from "@/modules/file-actions/FileReferenceLink";
import { decodeFileReference } from "@/modules/file-actions/references";
import { MarkdownCode } from "@/modules/markdown/markdown-code";
import {
  streamdownPlugins,
  streamdownRemarkPlugins,
} from "@/modules/markdown/streamdown-plugins";
import { cn } from "@/lib/utils";
import { MARKDOWN_CONTENT_CHANGE_EVENT } from "@/modules/markdown/lib/anchor";
import { MarkdownTable } from "@/modules/markdown/MarkdownTable";
import type {
  MarkdownDocument,
  MarkdownDocumentBlock,
} from "@/modules/markdown/lib/document";
import {
  classifyMarkdownLink,
  isMarkdownExternalOpenGesture,
} from "@/modules/markdown/lib/links";
import {
  ProgressiveMountStore,
  startProgressiveMounting,
} from "@/modules/markdown/lib/progressiveMount";
import { buildMarkdownRehypePlugins } from "@/modules/markdown/lib/rehype";
import {
  markdownBlockRenderContent,
  remarkMarkdownBlockSourcePosition,
} from "@/modules/markdown/lib/sourcePosition";
import {
  MarkdownImageProvider,
  MarkdownPreviewImage,
} from "@/modules/markdown/MarkdownPreviewImage";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ComponentPropsWithoutRef, CSSProperties } from "react";
import {
  createContext,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Block, type BlockProps, Streamdown } from "streamdown";

const INITIAL_RENDER_MIN_HEIGHT = 1_200;
const INITIAL_RENDER_VIEWPORTS = 2;
const INITIAL_RENDER_MIN_BLOCKS = 2;
const INITIAL_RENDER_MAX_BLOCKS = 24;
const BLOCK_PREFETCH_MARGIN = 1_200;
const BLOCK_PREFETCH_RADIUS = 2;
const IDLE_BATCH_SIZE = 2;
const IDLE_TIMEOUT = 500;

const progressiveRemarkPlugins = [
  remarkMarkdownBlockSourcePosition,
  ...streamdownRemarkPlugins,
];

type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & {
  node?: unknown;
  "data-block"?: string;
};

type ProgressiveBlockContextValue = {
  store: ProgressiveMountStore;
  document: MarkdownDocument;
  observePlaceholder: (element: HTMLElement) => () => void;
  registerBlockElement: (index: number, element: HTMLElement) => () => void;
  notifyContentChange: () => void;
};

type MarkdownLinkProps = ComponentPropsWithoutRef<"a"> & {
  node?: unknown;
};

const MarkdownVisibilityContext = createContext(true);
const MarkdownFragmentNavigationContext = createContext<
  (fragment: string) => void
>(() => {});
const MarkdownFileNavigationContext = createContext({
  openFile: (_path: string, _line?: number): void | Promise<void> => {},
  openDirectory: (_path: string): void | Promise<void> => {},
});
const ProgressiveBlockContext =
  createContext<ProgressiveBlockContextValue | null>(null);

const codeTargets = new Map<Element, () => void>();
let codeObserver: IntersectionObserver | null = null;

function disconnectCodeObserverIfIdle() {
  if (codeTargets.size > 0 || !codeObserver) return;
  codeObserver.disconnect();
  codeObserver = null;
}

function observeCodeNearViewport(
  element: Element,
  activate: () => void,
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    activate();
    return () => {};
  }

  codeObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = codeTargets.get(entry.target);
        if (!callback) continue;
        codeTargets.delete(entry.target);
        codeObserver?.unobserve(entry.target);
        callback();
      }
      disconnectCodeObserverIfIdle();
    },
    { rootMargin: "800px 0px" },
  );

  codeTargets.set(element, activate);
  codeObserver.observe(element);
  return () => {
    codeTargets.delete(element);
    codeObserver?.unobserve(element);
    disconnectCodeObserverIfIdle();
  };
}

function MarkdownPreviewCode({
  className,
  children,
  node: _node,
  ...props
}: MarkdownCodeProps) {
  const visible = useContext(MarkdownVisibilityContext);
  const elementRef = useRef<HTMLElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const block = "data-block" in props;

  useEffect(() => {
    if (!block || !visible || nearViewport) return;
    const element = elementRef.current;
    if (!element) return;
    return observeCodeNearViewport(element, () => setNearViewport(true));
  }, [block, nearViewport, visible]);

  if (!block || nearViewport) {
    return (
      <MarkdownCode className={className} variant="document" {...props}>
        {children}
      </MarkdownCode>
    );
  }

  return (
    <code
      ref={elementRef}
      className={cn(
        className,
        "block max-w-full overflow-x-auto whitespace-pre px-4 py-3 font-mono text-[12px] leading-[1.5] text-foreground",
      )}
      {...props}
    >
      {children}
    </code>
  );
}

/** 渲染受控预览链接，片段留在当前文档，允许的外链交给系统浏览器。 */
function MarkdownPreviewLink({
  href,
  children,
  title,
  node: _node,
  ...props
}: MarkdownLinkProps) {
  const navigateToFragment = useContext(MarkdownFragmentNavigationContext);
  const fileNavigation = useContext(MarkdownFileNavigationContext);
  const reference = decodeFileReference(href ?? "");
  if (reference && href) {
    return (
      <FileReferenceLink
        {...props}
        key={href}
        href={href}
        reference={reference}
        onOpen={fileNavigation.openFile}
        onOpenDirectory={fileNavigation.openDirectory}
      >
        {children}
      </FileReferenceLink>
    );
  }
  const target = classifyMarkdownLink(href);
  if (target.kind === "blocked") {
    return (
      <Hint content={href}>
        <span>{children}</span>
      </Hint>
    );
  }

  return (
    <Hint content={title ?? href}>
      <a
        {...props}
        href={href}
        data-streamdown="link"
        rel="noreferrer"
        onAuxClick={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          if (target.kind === "fragment") {
            navigateToFragment(target.fragment);
          } else if (isMarkdownExternalOpenGesture(event)) {
            void openUrl(target.url).catch((error) =>
              console.error("[markdown-preview] open link failed", error),
            );
          }
        }}
      >
        {children}
      </a>
    </Hint>
  );
}

const markdownComponents = {
  a: MarkdownPreviewLink,
  code: MarkdownPreviewCode,
  img: MarkdownPreviewImage,
  table: MarkdownTable,
};

export function initialMarkdownBlockCount(
  blocks: readonly MarkdownDocumentBlock[],
  viewportHeight: number,
): number {
  if (blocks.length === 0) return 0;
  const targetHeight = Math.max(
    INITIAL_RENDER_MIN_HEIGHT,
    Math.max(0, viewportHeight) * INITIAL_RENDER_VIEWPORTS,
  );
  let estimatedHeight = 0;
  let count = 0;
  while (
    count < blocks.length &&
    count < INITIAL_RENDER_MAX_BLOCKS &&
    (estimatedHeight < targetHeight || count < INITIAL_RENDER_MIN_BLOCKS)
  ) {
    estimatedHeight += blocks[count]?.estimatedHeight ?? 0;
    count += 1;
  }
  return count;
}

function ProgressiveMarkdownBlock(props: BlockProps) {
  const context = useContext(ProgressiveBlockContext);
  if (!context) {
    throw new Error("Progressive Markdown block rendered without its context");
  }

  const {
    store,
    document,
    observePlaceholder,
    registerBlockElement,
    notifyContentChange,
  } = context;
  const block = document.blocks[props.index];
  const placeholderRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<HTMLDivElement>(null);
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(props.index, listener),
    [props.index, store],
  );
  const getSnapshot = useCallback(
    () => store.isMounted(props.index),
    [props.index, store],
  );
  const mounted = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (mounted) return;
    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    return observePlaceholder(placeholder);
  }, [mounted, observePlaceholder]);

  useLayoutEffect(() => {
    if (!mounted) return;
    const element = mountedRef.current;
    if (!element) return;
    const unregister = registerBlockElement(props.index, element);
    notifyContentChange();
    return unregister;
  }, [mounted, notifyContentChange, props.index, registerBlockElement]);

  if (!block?.content.trim()) return null;

  const blockAttributes = {
    "data-markdown-block-index": String(props.index),
    "data-markdown-block-start-line": String(block.startLine),
    "data-markdown-block-end-line": String(block.endLine),
  };

  if (!mounted) {
    return (
      <div
        ref={placeholderRef}
        {...blockAttributes}
        data-markdown-block-placeholder
        aria-hidden="true"
        style={{ height: block.estimatedHeight }}
      />
    );
  }

  return (
    <div
      ref={mountedRef}
      {...blockAttributes}
      data-markdown-block-mounted
      className="space-y-4 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      style={
        {
          contentVisibility: "auto",
          containIntrinsicSize: `auto ${Math.max(1, block.estimatedHeight)}px`,
        } as CSSProperties
      }
    >
      <Block {...props} />
    </div>
  );
}

const MemoizedProgressiveMarkdownBlock = memo(ProgressiveMarkdownBlock);

export type MarkdownDocumentRendererHandle = {
  ensureBlock: (index: number) => void;
  ensureAllBlocks: () => void;
  findBlockElement: (index: number) => HTMLElement | null;
};

type Props = {
  document: MarkdownDocument;
  documentPath: string;
  mode: "dark" | "light";
  visible: boolean;
  scrollContainer: HTMLElement;
  onFragmentNavigate: (fragment: string) => void;
  onFileReferenceOpen: (path: string, line?: number) => void | Promise<void>;
  onFileReferenceOpenDirectory: (path: string) => void | Promise<void>;
};

/**
 * Markdown 文档渲染器。
 *
 * 普通文档单次静态解析，超大文档按视口渐进挂载，同时保持全局标题 slug 和源码行映射。
 */
export const MarkdownDocumentRenderer = forwardRef<
  MarkdownDocumentRendererHandle,
  Props
>(function MarkdownDocumentRenderer(
  {
    document,
    documentPath,
    mode,
    visible,
    scrollContainer,
    onFragmentNavigate,
    onFileReferenceOpen,
    onFileReferenceOpenDirectory,
  },
  ref,
) {
  const progressive = document.progressive;
  const headingSlugById = useMemo(
    () =>
      Object.fromEntries(
        document.outline.map((heading) => [heading.id, heading.slug]),
      ),
    [document.outline],
  );
  const rehypePlugins = useMemo(
    () => buildMarkdownRehypePlugins(headingSlugById, documentPath, mode),
    [documentPath, headingSlugById, mode],
  );
  const store = useMemo(
    () =>
      new ProgressiveMountStore(
        document.blocks.length,
        progressive
          ? initialMarkdownBlockCount(
              document.blocks,
              scrollContainer.clientHeight,
            )
          : document.blocks.length,
      ),
    [document, progressive, scrollContainer],
  );
  const placeholderNodesRef = useRef(new Set<HTMLElement>());
  const placeholderObserverRef = useRef<IntersectionObserver | null>(null);
  const blockElementsRef = useRef(new Map<number, HTMLElement>());
  const contentChangeFrameRef = useRef(0);

  useEffect(
    () => () => {
      store.dispose();
    },
    [store],
  );

  useEffect(() => {
    if (!progressive) return;
    return startProgressiveMounting(store, {
      active: visible,
      batchSize: IDLE_BATCH_SIZE,
      timeout: IDLE_TIMEOUT,
    });
  }, [progressive, store, visible]);

  useEffect(() => {
    if (!progressive || !visible || typeof IntersectionObserver === "undefined")
      return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number(
            (entry.target as HTMLElement).dataset.markdownBlockIndex,
          );
          if (Number.isInteger(index)) {
            store.mountAround(index, BLOCK_PREFETCH_RADIUS);
          }
        }
      },
      {
        root: scrollContainer,
        rootMargin: `${BLOCK_PREFETCH_MARGIN}px 0px`,
      },
    );
    placeholderObserverRef.current = observer;
    for (const node of placeholderNodesRef.current) observer.observe(node);

    return () => {
      observer.disconnect();
      if (placeholderObserverRef.current === observer) {
        placeholderObserverRef.current = null;
      }
    };
  }, [progressive, scrollContainer, store, visible]);

  useEffect(
    () => () => {
      if (contentChangeFrameRef.current !== 0) {
        cancelAnimationFrame(contentChangeFrameRef.current);
      }
    },
    [],
  );

  const observePlaceholder = useCallback((element: HTMLElement) => {
    placeholderNodesRef.current.add(element);
    placeholderObserverRef.current?.observe(element);
    return () => {
      placeholderNodesRef.current.delete(element);
      placeholderObserverRef.current?.unobserve(element);
    };
  }, []);

  const notifyContentChange = useCallback(() => {
    if (contentChangeFrameRef.current !== 0) return;
    contentChangeFrameRef.current = requestAnimationFrame(() => {
      contentChangeFrameRef.current = 0;
      scrollContainer.dispatchEvent(new Event(MARKDOWN_CONTENT_CHANGE_EVENT));
    });
  }, [scrollContainer]);

  const registerBlockElement = useCallback(
    (index: number, element: HTMLElement) => {
      blockElementsRef.current.set(index, element);
      return () => {
        if (blockElementsRef.current.get(index) === element) {
          blockElementsRef.current.delete(index);
        }
      };
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      ensureBlock: (index) => {
        if (progressive) store.mountAround(index, BLOCK_PREFETCH_RADIUS);
      },
      ensureAllBlocks: () => {
        if (progressive) store.mountNext(store.blockCount);
      },
      findBlockElement: (index) => blockElementsRef.current.get(index) ?? null,
    }),
    [progressive, store],
  );

  const parseMarkdownIntoBlocks = useMemo(
    () => () => document.blocks.map(markdownBlockRenderContent),
    [document.blocks],
  );
  const progressiveContext = useMemo<ProgressiveBlockContextValue>(
    () => ({
      store,
      document,
      observePlaceholder,
      registerBlockElement,
      notifyContentChange,
    }),
    [
      document,
      notifyContentChange,
      observePlaceholder,
      registerBlockElement,
      store,
    ],
  );

  // Streamdown 缓存解析结果，切换明暗模式时需重新解析 picture 候选。
  return (
    <MarkdownFragmentNavigationContext.Provider value={onFragmentNavigate}>
      <MarkdownFileNavigationContext.Provider
        value={{
          openFile: onFileReferenceOpen,
          openDirectory: onFileReferenceOpenDirectory,
        }}
      >
        <MarkdownVisibilityContext.Provider value={visible}>
          <MarkdownImageProvider
            documentPath={documentPath}
            scrollRoot={scrollContainer}
            visible={visible}
          >
            {progressive ? (
              <ProgressiveBlockContext.Provider value={progressiveContext}>
                <Streamdown
                  key={mode}
                  className="markdown-content select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                  components={markdownComponents}
                  plugins={streamdownPlugins}
                  rehypePlugins={rehypePlugins}
                  remarkPlugins={progressiveRemarkPlugins}
                  mode="streaming"
                  parseIncompleteMarkdown={false}
                  tableMaxHeight="none"
                  isAnimating={false}
                  BlockComponent={MemoizedProgressiveMarkdownBlock}
                  parseMarkdownIntoBlocksFn={parseMarkdownIntoBlocks}
                >
                  {document.source}
                </Streamdown>
              </ProgressiveBlockContext.Provider>
            ) : (
              <Streamdown
                key={mode}
                tableMaxHeight="none"
                className="markdown-content select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                components={markdownComponents}
                plugins={streamdownPlugins}
                rehypePlugins={rehypePlugins}
                remarkPlugins={streamdownRemarkPlugins}
                mode="static"
                parseIncompleteMarkdown={false}
                isAnimating={false}
              >
                {document.source}
              </Streamdown>
            )}
          </MarkdownImageProvider>
        </MarkdownVisibilityContext.Provider>
      </MarkdownFileNavigationContext.Provider>
    </MarkdownFragmentNavigationContext.Provider>
  );
});
