import type { MarkdownDocumentBlock } from "@/modules/markdown/lib/document";

const BLOCK_MARKER = /^<!--terax-markdown-block:(\d+):(\d+)-->\s*$/;

export const MARKDOWN_BLOCK_INDEX_DATA_KEY = "teraxMarkdownBlockIndex";
export const MARKDOWN_LINE_OFFSET_DATA_KEY = "teraxMarkdownLineOffset";

type MarkdownAstNode = {
  type?: string;
  value?: unknown;
};

type MarkdownAstRoot = {
  children?: MarkdownAstNode[];
};

export type MarkdownProcessingFile = {
  data?: Record<string, unknown>;
};

export function markdownBlockRenderContent(
  block: MarkdownDocumentBlock,
): string {
  return `<!--terax-markdown-block:${block.index}:${block.startLine}-->\n${block.content}`;
}

export function remarkMarkdownBlockSourcePosition() {
  return (tree: MarkdownAstRoot, file: MarkdownProcessingFile) => {
    const first = tree.children?.[0];
    if (first?.type !== "html" || typeof first.value !== "string") return;
    const match = first.value.match(BLOCK_MARKER);
    if (!match) return;

    const blockIndex = Number(match[1]);
    const startLine = Number(match[2]);
    if (!Number.isInteger(blockIndex) || !Number.isInteger(startLine)) return;

    file.data ??= {};
    file.data[MARKDOWN_BLOCK_INDEX_DATA_KEY] = blockIndex;
    file.data[MARKDOWN_LINE_OFFSET_DATA_KEY] = startLine - 2;
    tree.children?.shift();
  };
}

export function readMarkdownProcessingNumber(
  file: MarkdownProcessingFile | undefined,
  key: string,
): number | undefined {
  const value = file?.data?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
