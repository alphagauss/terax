/**
 * 本文件维护 Markdown 渲染结果与源码位置之间的映射。
 *
 * 同时提供目录定位和文档内片段滚动，所有滚动只作用于当前预览容器。
 */

import {
  MARKDOWN_BLOCK_INDEX_DATA_KEY,
  MARKDOWN_LINE_OFFSET_DATA_KEY,
  type MarkdownProcessingFile,
  readMarkdownProcessingNumber,
} from "@/modules/markdown/lib/sourcePosition";

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
  headingSlugById?: Record<string, string>;
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
const SOURCE_SELECTOR =
  "[data-markdown-source-line],[data-markdown-block-start-line]";

export const MARKDOWN_ACTIVATION_OFFSET = 32;
export const MARKDOWN_CONTENT_CHANGE_EVENT = "markdown-content-change";

/** 为可导航 Markdown 元素附加全局源码位置和稳定标题标识。 */
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
    const headingCounts = new Map<number, number>();

    const visit = (node: PositionedNode, parentTag?: string) => {
      const start = node.position?.start?.line;
      const end = node.position?.end?.line;
      const tag = node.tagName;
      const fencedCode = tag === "code" && parentTag === "pre";
      if (
        node.type === "element" &&
        tag &&
        (SOURCE_BLOCK_TAGS.has(tag) || fencedCode) &&
        typeof start === "number"
      ) {
        const sourceStart = start + lineOffset;
        const sourceEnd = (end ?? start) + lineOffset;
        const heading = /^h[1-6]$/.test(tag);
        const occurrence = heading
          ? (headingCounts.get(sourceStart) ?? 0) + 1
          : 0;
        if (heading) headingCounts.set(sourceStart, occurrence);
        const headingId = heading
          ? `markdown-heading-${sourceStart}${occurrence > 1 ? `-${occurrence}` : ""}`
          : undefined;
        const headingSlug = headingId
          ? options.headingSlugById?.[headingId]
          : undefined;
        const existingId = node.properties?.id;
        node.properties = {
          ...node.properties,
          "data-markdown-source-line": String(sourceStart),
          "data-markdown-source-end-line": String(sourceEnd),
          ...(blockIndex !== undefined && {
            "data-markdown-block-index": String(blockIndex),
          }),
          ...(headingId && {
            id:
              typeof existingId === "string"
                ? existingId
                : headingSlug !== undefined
                  ? `user-content-${headingSlug}`
                  : headingId,
            "data-markdown-heading-id": headingId,
          }),
        };
      }
      node.children?.forEach((child) => {
        visit(child, tag);
      });
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

function sourceElementAtActivation(container: HTMLElement): HTMLElement | null {
  const viewport = container.getBoundingClientRect();
  const y =
    viewport.top + Math.min(MARKDOWN_ACTIVATION_OFFSET, viewport.height);
  const inset = Math.min(40, viewport.width / 4);
  const xPositions = [
    viewport.left + inset,
    viewport.left + viewport.width / 2,
    viewport.right - inset,
  ];

  for (const x of xPositions) {
    for (const element of container.ownerDocument.elementsFromPoint?.(x, y) ??
      []) {
      if (!(element instanceof HTMLElement) || !container.contains(element)) {
        continue;
      }
      const sourceElement = element.closest<HTMLElement>(SOURCE_SELECTOR);
      if (sourceElement && container.contains(sourceElement)) {
        return sourceElement;
      }
    }
  }

  let containing: HTMLElement | null = null;
  let containingHeight = Number.POSITIVE_INFINITY;
  let preceding: HTMLElement | null = null;
  for (const element of container.querySelectorAll<HTMLElement>(
    SOURCE_SELECTOR,
  )) {
    const rect = element.getBoundingClientRect();
    if (rect.top <= y && rect.bottom > y) {
      if (rect.height < containingHeight) {
        containing = element;
        containingHeight = rect.height;
      }
      continue;
    }
    if (rect.top > y) return containing ?? preceding ?? element;
    preceding = element;
  }
  return containing ?? preceding;
}

export function readRenderedViewportSourceLine(
  container: HTMLElement,
): number | undefined {
  const element = sourceElementAtActivation(container);
  const range = element ? sourceRange(element) : null;
  if (!element || !range) return undefined;

  const rect = element.getBoundingClientRect();
  const activationY =
    container.getBoundingClientRect().top + MARKDOWN_ACTIVATION_OFFSET;
  const progress = Math.max(
    0,
    Math.min(1, (activationY - rect.top) / Math.max(1, rect.height)),
  );
  return Math.round(range.start + (range.end - range.start) * progress);
}

export function readActiveRenderedHeadingId(
  container: HTMLElement,
): string | null {
  const activationY =
    container.getBoundingClientRect().top + MARKDOWN_ACTIVATION_OFFSET;
  let active: string | null = null;
  for (const heading of container.querySelectorAll<HTMLElement>(
    "[data-markdown-heading-id]",
  )) {
    if (heading.getBoundingClientRect().top > activationY + 1) break;
    active = heading.dataset.markdownHeadingId ?? active;
  }
  return active;
}

export function restoreRenderedSourceLine(
  container: HTMLElement,
  sourceLine: number,
  root: ParentNode = container,
): boolean {
  let target: HTMLElement | null = null;
  let targetRange: ReturnType<typeof sourceRange> = null;
  let preceding: HTMLElement | null = null;
  let precedingRange: ReturnType<typeof sourceRange> = null;

  for (const element of root.querySelectorAll<HTMLElement>(SOURCE_SELECTOR)) {
    const range = sourceRange(element);
    if (!range) continue;
    if (range.start <= sourceLine && sourceLine <= range.end) {
      if (
        !targetRange ||
        range.end - range.start < targetRange.end - targetRange.start
      ) {
        target = element;
        targetRange = range;
      }
    } else if (
      range.start <= sourceLine &&
      (!precedingRange || range.start >= precedingRange.start)
    ) {
      preceding = element;
      precedingRange = range;
    }
  }

  target ??= preceding;
  targetRange ??= precedingRange;
  if (!target || !targetRange) return false;

  const rect = target.getBoundingClientRect();
  const viewportTop = container.getBoundingClientRect().top;
  const span = targetRange.end - targetRange.start;
  const progress = span > 0 ? (sourceLine - targetRange.start) / span : 0;
  container.scrollTop +=
    rect.top +
    rect.height * progress -
    viewportTop -
    MARKDOWN_ACTIVATION_OFFSET;
  return true;
}

/** 解码并规范化 sanitizer 可能添加 `user-content-` 前缀的片段。 */
export function normalizeMarkdownFragment(fragment: string): string {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // 非法百分号转义按字面值处理，避免一次坏链接中断整个预览。
  }
  return decoded.startsWith("user-content-")
    ? decoded.slice("user-content-".length)
    : decoded;
}

/**
 * 将片段目标滚动到当前 Markdown 容器顶部附近。
 *
 * 几何差值会换算为布局像素，避免应用 CSS zoom 时产生距离倍增。
 */
export function scrollRenderedFragment(
  container: HTMLElement,
  root: ParentNode,
  fragment: string,
): boolean {
  const normalized = normalizeMarkdownFragment(fragment);
  if (!normalized) {
    container.scrollTop = 0;
    return true;
  }
  const ids = new Set([
    normalized,
    `user-content-${normalized}`,
    `user-content-user-content-${normalized}`,
  ]);
  const target = Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
    (element) => ids.has(element.id),
  );
  if (!target) return false;

  const anchor =
    target.closest<HTMLElement>(
      "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre",
    ) ?? target;
  const containerRect = container.getBoundingClientRect();
  const layoutHeight = container.offsetHeight;
  const scale = layoutHeight > 0 ? containerRect.height / layoutHeight : 1;
  container.scrollTop +=
    (anchor.getBoundingClientRect().top - containerRect.top) /
      Math.max(scale, Number.EPSILON) -
    8;
  return true;
}
