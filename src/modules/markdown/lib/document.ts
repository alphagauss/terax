import { Lexer, type Token, type Tokens } from "marked";
import { parseMarkdownIntoBlocks } from "streamdown";

export const MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD = 50_000;
export const MARKDOWN_PROGRESSIVE_BLOCK_THRESHOLD = 120;

const MARKDOWN_RENDER_BLOCK_MAX_CHARACTERS = 4_000;
const MARKDOWN_RENDER_BLOCK_MAX_SOURCE_BLOCKS = 16;

export type MarkdownDocumentBlock = {
  index: number;
  content: string;
  startLine: number;
  endLine: number;
  estimatedHeight: number;
  key: string;
};

export type MarkdownDocumentHeading = {
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  sourceLine: number;
  blockIndex: number;
};

export type MarkdownDocument = {
  source: string;
  blocks: MarkdownDocumentBlock[];
  sourceBlockCount: number;
  outline: MarkdownDocumentHeading[];
  lineCount: number;
};

type NormalizedSource = {
  value: string;
  removedCarriageReturnOffsets: number[] | null;
};

type BlockRange = {
  startOffset: number;
  endOffset: number;
  tokenIndexes: number[];
};

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function normalizeSource(source: string): NormalizedSource {
  if (!source.includes("\r")) {
    return { value: source, removedCarriageReturnOffsets: null };
  }

  const removedCarriageReturnOffsets: number[] = [];
  const value = source.replace(/\r\n?/g, (match, originalOffset: number) => {
    if (match.length === 2) {
      removedCarriageReturnOffsets.push(
        originalOffset - removedCarriageReturnOffsets.length,
      );
    }
    return "\n";
  });

  return {
    value,
    removedCarriageReturnOffsets:
      removedCarriageReturnOffsets.length > 0
        ? removedCarriageReturnOffsets
        : null,
  };
}

function originalOffsetAt(
  normalizedOffset: number,
  removedCarriageReturnOffsets: readonly number[] | null,
): number {
  if (!removedCarriageReturnOffsets) return normalizedOffset;

  let low = 0;
  let high = removedCarriageReturnOffsets.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (removedCarriageReturnOffsets[middle] < normalizedOffset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return normalizedOffset + low;
}

function countLineBreaks(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function singleDocumentRange(
  normalizedLength: number,
  tokenCount: number,
): BlockRange[] {
  if (normalizedLength === 0) return [];
  return [
    {
      startOffset: 0,
      endOffset: normalizedLength,
      tokenIndexes: Array.from({ length: tokenCount }, (_, index) => index),
    },
  ];
}

function buildBlockRanges(
  source: string,
  tokens: readonly Token[],
): { ranges: BlockRange[]; tokenBlockIndexes: number[] } {
  if (source.length === 0) {
    return { ranges: [], tokenBlockIndexes: [] };
  }

  const contents = parseMarkdownIntoBlocks(source);
  const ranges: BlockRange[] = [];
  let blockOffset = 0;
  for (const content of contents) {
    if (!source.startsWith(content, blockOffset)) {
      return {
        ranges: singleDocumentRange(source.length, tokens.length),
        tokenBlockIndexes: Array(tokens.length).fill(0),
      };
    }
    ranges.push({
      startOffset: blockOffset,
      endOffset: blockOffset + content.length,
      tokenIndexes: [],
    });
    blockOffset += content.length;
  }

  if (blockOffset !== source.length || ranges.length === 0) {
    return {
      ranges: singleDocumentRange(source.length, tokens.length),
      tokenBlockIndexes: Array(tokens.length).fill(0),
    };
  }

  const tokenBlockIndexes: number[] = [];
  let tokenOffset = 0;
  let rangeIndex = 0;
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    while (
      rangeIndex < ranges.length - 1 &&
      tokenOffset >= ranges[rangeIndex].endOffset
    ) {
      rangeIndex += 1;
    }
    const range = ranges[rangeIndex];
    const tokenEnd = tokenOffset + token.raw.length;
    if (
      !range ||
      tokenOffset < range.startOffset ||
      tokenEnd > range.endOffset
    ) {
      return {
        ranges: singleDocumentRange(source.length, tokens.length),
        tokenBlockIndexes: Array(tokens.length).fill(0),
      };
    }
    range.tokenIndexes.push(tokenIndex);
    tokenBlockIndexes[tokenIndex] = rangeIndex;
    tokenOffset = tokenEnd;
  }

  if (tokenOffset !== source.length) {
    return {
      ranges: singleDocumentRange(source.length, tokens.length),
      tokenBlockIndexes: Array(tokens.length).fill(0),
    };
  }

  return { ranges, tokenBlockIndexes };
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/gi,
    (entity, name: string) => {
      if (name[0] !== "#") return HTML_ENTITIES[name.toLowerCase()] ?? entity;
      const hexadecimal = name[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(
        name.slice(hexadecimal ? 2 : 1),
        hexadecimal ? 16 : 10,
      );
      if (
        !Number.isFinite(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff
      ) {
        return entity;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return entity;
      }
    },
  );
}

function inlineTokenText(token: Token): string {
  if (token.type === "html") return "";
  if (token.type === "br") return " ";
  if (token.type === "checkbox") return "";
  if ("tokens" in token && Array.isArray(token.tokens)) {
    return token.tokens.map(inlineTokenText).join("");
  }
  if ("text" in token && typeof token.text === "string") return token.text;
  return "";
}

function headingTitle(token: Tokens.Heading): string {
  return decodeHtmlEntities(token.tokens.map(inlineTokenText).join(""))
    .replace(/\s+/g, " ")
    .trim();
}

function isHeadingToken(token: Token): token is Tokens.Heading {
  return (
    token.type === "heading" &&
    "depth" in token &&
    typeof token.depth === "number" &&
    "text" in token &&
    typeof token.text === "string" &&
    "tokens" in token &&
    Array.isArray(token.tokens)
  );
}

function visitTokenSequence(
  tokens: readonly Token[],
  startLine: number,
  blockIndex: number,
  outline: MarkdownDocumentHeading[],
): void {
  let sourceLine = startLine;
  for (const token of tokens) {
    visitToken(token, sourceLine, blockIndex, outline);
    sourceLine += countLineBreaks(token.raw);
  }
}

function visitToken(
  token: Token,
  sourceLine: number,
  blockIndex: number,
  outline: MarkdownDocumentHeading[],
): void {
  if (isHeadingToken(token)) {
    const title = headingTitle(token);
    if (title) {
      outline.push({
        id: `markdown-heading-${sourceLine}`,
        level: token.depth as MarkdownDocumentHeading["level"],
        title,
        sourceLine,
        blockIndex,
      });
    }
    return;
  }

  if (token.type === "list") {
    let itemLine = sourceLine;
    for (const item of token.items) {
      visitTokenSequence(item.tokens, itemLine, blockIndex, outline);
      itemLine += countLineBreaks(item.raw);
    }
    return;
  }

  if (token.type === "blockquote" && Array.isArray(token.tokens)) {
    visitTokenSequence(token.tokens, sourceLine, blockIndex, outline);
  }
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function wrappedLineCount(content: string, charactersPerLine: number): number {
  let count = 0;
  for (const line of content.split("\n")) {
    const expandedLength = line.length + (line.match(/\t/g)?.length ?? 0) * 3;
    count += Math.max(1, Math.ceil(expandedLength / charactersPerLine));
  }
  return count;
}

function estimateBlockHeight(
  content: string,
  tokens: readonly Token[],
): number {
  if (!content.trim()) return 0;

  const substantiveTokens = tokens.filter((token) => token.type !== "space");
  const onlyToken =
    substantiveTokens.length === 1 ? substantiveTokens[0] : null;
  if (onlyToken?.type === "code") {
    return Math.max(72, content.split("\n").length * 20 + 48);
  }
  if (onlyToken?.type === "heading") {
    const lineHeight = [0, 42, 36, 31, 28, 25, 23][onlyToken.depth] ?? 24;
    return Math.max(
      lineHeight + 24,
      wrappedLineCount(onlyToken.text, 48) * lineHeight + 24,
    );
  }
  if (onlyToken?.type === "table") {
    return Math.max(96, content.split("\n").length * 34 + 24);
  }
  if (onlyToken?.type === "hr") return 32;

  const visualLines = wrappedLineCount(content, 72);
  const blockPadding =
    onlyToken?.type === "list" || onlyToken?.type === "blockquote" ? 24 : 16;
  return Math.max(32, visualLines * 24 + blockPadding);
}

export function buildMarkdownDocument(source: string): MarkdownDocument {
  const normalized = normalizeSource(source);
  const tokens = Lexer.lex(normalized.value, { gfm: true });
  const { ranges, tokenBlockIndexes } = buildBlockRanges(
    normalized.value,
    tokens,
  );
  const blocks: MarkdownDocumentBlock[] = [];
  let currentLine = 1;

  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const normalizedContent = normalized.value.slice(
      range.startOffset,
      range.endOffset,
    );
    const originalStart = originalOffsetAt(
      range.startOffset,
      normalized.removedCarriageReturnOffsets,
    );
    const originalEnd = originalOffsetAt(
      range.endOffset,
      normalized.removedCarriageReturnOffsets,
    );
    const content = source.slice(originalStart, originalEnd);
    const lineBreaks = countLineBreaks(normalizedContent);
    const endLine =
      currentLine + lineBreaks - (normalizedContent.endsWith("\n") ? 1 : 0);
    const blockTokens = range.tokenIndexes.map(
      (tokenIndex) => tokens[tokenIndex],
    );

    blocks.push({
      index,
      content,
      startLine: currentLine,
      endLine: Math.max(currentLine, endLine),
      estimatedHeight: estimateBlockHeight(normalizedContent, blockTokens),
      key: `markdown-block-${index}-${hashString(content)}`,
    });
    currentLine += lineBreaks;
  }

  const outline: MarkdownDocumentHeading[] = [];
  let tokenLine = 1;
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    visitToken(token, tokenLine, tokenBlockIndexes[tokenIndex] ?? 0, outline);
    tokenLine += countLineBreaks(token.raw);
  }

  outline.sort((left, right) => left.sourceLine - right.sourceLine);

  return {
    source,
    blocks,
    sourceBlockCount: blocks.length,
    outline,
    lineCount: countLineBreaks(normalized.value) + 1,
  };
}

export function coalesceMarkdownDocument(
  document: MarkdownDocument,
): MarkdownDocument {
  if (document.blocks.length < 2) return document;

  const blocks: MarkdownDocumentBlock[] = [];
  const renderIndexBySourceIndex = new Int32Array(document.blocks.length);
  let group: MarkdownDocumentBlock[] = [];
  let groupCharacters = 0;

  const flush = () => {
    if (group.length === 0) return;
    const index = blocks.length;
    const first = group[0];
    const last = group[group.length - 1];
    const content = group.map((block) => block.content).join("");
    const substantiveBlocks = group.reduce(
      (count, block) => count + (block.content.trim() ? 1 : 0),
      0,
    );

    blocks.push({
      index,
      content,
      startLine: first.startLine,
      endLine: last.endLine,
      estimatedHeight:
        group.reduce((height, block) => height + block.estimatedHeight, 0) +
        Math.max(0, substantiveBlocks - 1) * 16,
      key: `markdown-render-block-${index}-${hashString(content)}`,
    });
    for (const block of group) renderIndexBySourceIndex[block.index] = index;
    group = [];
    groupCharacters = 0;
  };

  for (const block of document.blocks) {
    const wouldExceedCharacters =
      groupCharacters > 0 &&
      groupCharacters + block.content.length >
        MARKDOWN_RENDER_BLOCK_MAX_CHARACTERS;
    if (
      group.length >= MARKDOWN_RENDER_BLOCK_MAX_SOURCE_BLOCKS ||
      wouldExceedCharacters
    ) {
      flush();
    }
    group.push(block);
    groupCharacters += block.content.length;
    if (groupCharacters >= MARKDOWN_RENDER_BLOCK_MAX_CHARACTERS) flush();
  }
  flush();

  return {
    ...document,
    blocks,
    outline: document.outline.map((heading) => ({
      ...heading,
      blockIndex: renderIndexBySourceIndex[heading.blockIndex] ?? 0,
    })),
  };
}

export function prepareMarkdownDocument(source: string): MarkdownDocument {
  const document = buildMarkdownDocument(source);
  return shouldProgressivelyRender(document)
    ? coalesceMarkdownDocument(document)
    : document;
}

export function shouldProgressivelyRender(
  document: MarkdownDocument | string,
): boolean {
  if (typeof document === "string") {
    if (document.length >= MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD)
      return true;
    return (
      buildMarkdownDocument(document).blocks.length >=
      MARKDOWN_PROGRESSIVE_BLOCK_THRESHOLD
    );
  }
  return (
    document.source.length >= MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD ||
    document.sourceBlockCount >= MARKDOWN_PROGRESSIVE_BLOCK_THRESHOLD
  );
}

export function findBlockIndexForSourceLine(
  blocks: readonly MarkdownDocumentBlock[],
  sourceLine: number,
): number {
  if (blocks.length === 0) return -1;
  if (Number.isNaN(sourceLine) || sourceLine <= blocks[0].startLine) return 0;
  if (sourceLine === Number.POSITIVE_INFINITY) return blocks.length - 1;

  let low = 0;
  let high = blocks.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (blocks[middle].endLine >= sourceLine) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}
