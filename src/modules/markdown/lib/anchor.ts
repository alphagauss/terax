import {
  MARKDOWN_BLOCK_INDEX_DATA_KEY,
  MARKDOWN_LINE_OFFSET_DATA_KEY,
  type MarkdownProcessingFile,
  readMarkdownProcessingNumber,
} from "@/modules/markdown/lib/sourcePosition";

export type MarkdownAnchor = {
  sourceLine?: number;
  blockIndex?: number;
  offset: number;
  scrollRatio: number;
};

type PositionedNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: {
    start?: { line?: number };
    end?: { line?: number };
  };
  children?: PositionedNode[];
};

type SourcePositionOptions = {
  lineOffset?: number;
  blockIndex?: number;
};

const SOURCE_BLOCK_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "pre",
  "table",
  "hr",
]);

const SOURCE_BLOCK_SELECTOR = "[data-markdown-source-line]";
const SOURCE_POSITION_SELECTOR =
  "[data-markdown-source-line],[data-markdown-block-start-line]";

export const MARKDOWN_CONTENT_CHANGE_EVENT = "markdown-content-change";

export function rehypeMarkdownSourcePositions(
  options: SourcePositionOptions = {},
) {
  return (tree: PositionedNode, file?: MarkdownProcessingFile) => {
    const lineOffset =
      options.lineOffset ??
      readMarkdownProcessingNumber(file, MARKDOWN_LINE_OFFSET_DATA_KEY) ??
      0;
    const blockIndex =
      options.blockIndex ??
      readMarkdownProcessingNumber(file, MARKDOWN_BLOCK_INDEX_DATA_KEY);
    const visit = (node: PositionedNode) => {
      const start = node.position?.start?.line;
      const end = node.position?.end?.line;
      if (
        node.type === "element" &&
        node.tagName &&
        SOURCE_BLOCK_TAGS.has(node.tagName) &&
        typeof start === "number"
      ) {
        const sourceStart = start + lineOffset;
        const sourceEnd = (end ?? start) + lineOffset;
        const heading = /^h[1-6]$/.test(node.tagName);
        const headingId = heading
          ? `markdown-heading-${sourceStart}`
          : undefined;
        node.properties = {
          ...node.properties,
          "data-markdown-source-line": String(sourceStart),
          "data-markdown-source-end-line": String(sourceEnd),
          ...(blockIndex !== undefined && {
            "data-markdown-block-index": String(blockIndex),
          }),
          ...(headingId && {
            id: headingId,
            "data-markdown-heading-id": headingId,
          }),
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

function sourceRange(element: HTMLElement) {
  const start = Number(
    element.dataset.markdownSourceLine ??
      element.dataset.markdownBlockStartLine,
  );
  const end = Number(
    element.dataset.markdownSourceEndLine ??
      element.dataset.markdownBlockEndLine,
  );
  if (!Number.isFinite(start)) return null;
  return {
    start,
    end: Number.isFinite(end) ? Math.max(start, end) : start,
  };
}

function sourceBlocks(container: ParentNode): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(SOURCE_BLOCK_SELECTOR),
  );
}

function sourceElementAtViewport(container: HTMLElement): HTMLElement | null {
  const viewport = container.getBoundingClientRect();
  const ownerDocument = container.ownerDocument;
  if (ownerDocument?.elementsFromPoint && viewport.width > 0) {
    const inset = Math.min(40, viewport.width / 4);
    const xPositions = [
      viewport.left + inset,
      viewport.left + viewport.width / 2,
      viewport.right - inset,
    ];
    const scanHeight = Math.min(container.clientHeight, 128);
    for (let yOffset = 1; yOffset <= scanHeight; yOffset += 16) {
      for (const x of xPositions) {
        for (const element of ownerDocument.elementsFromPoint(
          x,
          viewport.top + yOffset,
        )) {
          if (!(element instanceof HTMLElement) || !container.contains(element))
            continue;
          const sourceElement = element.closest<HTMLElement>(
            SOURCE_POSITION_SELECTOR,
          );
          if (sourceElement && container.contains(sourceElement)) {
            return sourceElement;
          }
        }
      }
    }
  }

  for (const block of Array.from(
    container.querySelectorAll<HTMLElement>(SOURCE_POSITION_SELECTOR),
  )) {
    if (block.getBoundingClientRect().bottom > viewport.top + 1) return block;
  }
  return null;
}

function sourceLineWithinElement(
  element: HTMLElement,
  viewportTop: number,
): number | undefined {
  const range = sourceRange(element);
  if (!range) return undefined;
  const rect = element.getBoundingClientRect();
  const progress = Math.max(
    0,
    Math.min(1, (viewportTop - rect.top) / Math.max(1, rect.height)),
  );
  return Math.round(range.start + (range.end - range.start) * progress);
}

export function readRenderedViewportSourceLine(
  container: HTMLElement,
): number | undefined {
  const selected = sourceElementAtViewport(container);
  return selected
    ? sourceLineWithinElement(selected, container.getBoundingClientRect().top)
    : undefined;
}

function scrollRatio(container: HTMLElement): number {
  const scrollable = container.scrollHeight - container.clientHeight;
  return scrollable > 0 ? container.scrollTop / scrollable : 0;
}

export function captureRenderedAnchor(container: HTMLElement): MarkdownAnchor {
  const viewport = container.getBoundingClientRect();
  const selected = sourceElementAtViewport(container);

  if (!selected) return { offset: 0, scrollRatio: scrollRatio(container) };
  const range = sourceRange(selected);
  if (!range) return { offset: 0, scrollRatio: scrollRatio(container) };

  const rect = selected.getBoundingClientRect();
  const blockIndex = Number(selected.dataset.markdownBlockIndex);
  return {
    sourceLine: sourceLineWithinElement(selected, viewport.top),
    ...(Number.isInteger(blockIndex) && { blockIndex }),
    offset: Math.max(0, rect.top - viewport.top),
    scrollRatio: scrollRatio(container),
  };
}

export function restoreRenderedAnchor(
  container: HTMLElement,
  anchor: MarkdownAnchor,
  root: ParentNode = container,
): void {
  const blocks = sourceBlocks(root);
  const sourceLine = anchor.sourceLine;
  if (sourceLine == null || blocks.length === 0) {
    const scrollable = container.scrollHeight - container.clientHeight;
    container.scrollTop = Math.max(0, scrollable * anchor.scrollRatio);
    return;
  }

  let containing: HTMLElement | undefined;
  let containingRange: ReturnType<typeof sourceRange> = null;
  let preceding: HTMLElement | undefined;
  let precedingRange: ReturnType<typeof sourceRange> = null;
  for (const block of blocks) {
    const range = sourceRange(block);
    if (!range) continue;
    if (range.start <= sourceLine && sourceLine <= range.end) {
      if (
        !containingRange ||
        range.end - range.start < containingRange.end - containingRange.start
      ) {
        containing = block;
        containingRange = range;
      }
    } else if (
      range.start <= sourceLine &&
      (!precedingRange || range.start >= precedingRange.start)
    ) {
      preceding = block;
      precedingRange = range;
    }
  }

  const target = containing ?? preceding ?? blocks[0];
  const targetRange =
    containingRange ?? precedingRange ?? sourceRange(blocks[0]);

  if (!target || !targetRange) {
    const scrollable = container.scrollHeight - container.clientHeight;
    container.scrollTop = Math.max(0, scrollable * anchor.scrollRatio);
    return;
  }

  const viewport = container.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const lineSpan = targetRange.end - targetRange.start;
  const progress =
    lineSpan > 0 ? (sourceLine - targetRange.start) / lineSpan : 0;
  container.scrollTop +=
    rect.top + rect.height * progress - viewport.top - anchor.offset;
}
