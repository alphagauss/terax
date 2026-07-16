import { Lexer, type Token, type Tokens } from "marked";
import { parseMarkdownIntoBlocks } from "streamdown";

export const MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD = 512 * 1024;

const MARKDOWN_RENDER_BLOCK_TARGET_CHARACTERS = 8 * 1024;
const REFERENCE_DEFINITION = /^ {0,3}\[(?!\^)[^\]\n]+\]:/m;
const FOOTNOTE_REFERENCE = /\[\^[^\]\n]+\]/;

export type MarkdownDocumentBlock = {
  index: number;
  content: string;
  startLine: number;
  endLine: number;
  estimatedHeight: number;
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
  outline: MarkdownDocumentHeading[];
  progressive: boolean;
};

type OutlineHeading = Omit<MarkdownDocumentHeading, "blockIndex">;

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function countLineBreaks(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
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

function isHeadingToken(token: Token): token is Tokens.Heading {
  return (
    token.type === "heading" &&
    "depth" in token &&
    typeof token.depth === "number" &&
    "tokens" in token &&
    Array.isArray(token.tokens)
  );
}

function visitTokenSequence(
  tokens: readonly Token[],
  startLine: number,
  outline: OutlineHeading[],
  headingCounts: Map<number, number>,
) {
  let sourceLine = startLine;
  for (const token of tokens) {
    visitToken(token, sourceLine, outline, headingCounts);
    sourceLine += countLineBreaks(token.raw);
  }
}

function visitToken(
  token: Token,
  sourceLine: number,
  outline: OutlineHeading[],
  headingCounts: Map<number, number>,
) {
  if (isHeadingToken(token)) {
    const title = decodeHtmlEntities(token.tokens.map(inlineTokenText).join(""))
      .replace(/\s+/g, " ")
      .trim();
    if (!title) return;
    const occurrence = (headingCounts.get(sourceLine) ?? 0) + 1;
    headingCounts.set(sourceLine, occurrence);
    outline.push({
      id: `markdown-heading-${sourceLine}${occurrence > 1 ? `-${occurrence}` : ""}`,
      level: token.depth as MarkdownDocumentHeading["level"],
      title,
      sourceLine,
    });
    return;
  }

  if (token.type === "list") {
    let itemLine = sourceLine;
    for (const item of token.items) {
      visitTokenSequence(item.tokens, itemLine, outline, headingCounts);
      itemLine += countLineBreaks(item.raw);
    }
  } else if (token.type === "blockquote" && Array.isArray(token.tokens)) {
    visitTokenSequence(token.tokens, sourceLine, outline, headingCounts);
  }
}

function buildOutline(source: string): OutlineHeading[] {
  const outline: OutlineHeading[] = [];
  visitTokenSequence(Lexer.lex(source, { gfm: true }), 1, outline, new Map());
  return outline.sort((left, right) => left.sourceLine - right.sourceLine);
}

function estimatedBlockHeight(content: string): number {
  if (!content.trim()) return 0;
  const sourceLines = countLineBreaks(content) + 1;
  const wrappedLines = Math.max(sourceLines, Math.ceil(content.length / 72));
  return Math.max(48, wrappedLines * 22 + 16);
}

function makeBlocks(contents: readonly string[]): MarkdownDocumentBlock[] {
  const blocks: MarkdownDocumentBlock[] = [];
  let currentLine = 1;
  for (const content of contents) {
    const index = blocks.length;
    const lineBreaks = countLineBreaks(content);
    const endLine = currentLine + lineBreaks - (content.endsWith("\n") ? 1 : 0);
    blocks.push({
      index,
      content,
      startLine: currentLine,
      endLine: Math.max(currentLine, endLine),
      estimatedHeight: estimatedBlockHeight(content),
    });
    currentLine += lineBreaks;
  }
  return blocks;
}

function progressiveBlockContents(source: string): string[] | null {
  if (
    source.length < MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD ||
    REFERENCE_DEFINITION.test(source) ||
    FOOTNOTE_REFERENCE.test(source)
  ) {
    return null;
  }

  const sourceBlocks = parseMarkdownIntoBlocks(source);
  if (sourceBlocks.length < 2 || sourceBlocks.join("") !== source) return null;

  const contents: string[] = [];
  let group = "";
  for (const block of sourceBlocks) {
    if (
      group &&
      group.length + block.length > MARKDOWN_RENDER_BLOCK_TARGET_CHARACTERS
    ) {
      contents.push(group);
      group = "";
    }
    group += block;
    if (group.length >= MARKDOWN_RENDER_BLOCK_TARGET_CHARACTERS) {
      contents.push(group);
      group = "";
    }
  }
  if (group) contents.push(group);
  return contents.length > 1 ? contents : null;
}

export function prepareMarkdownDocument(source: string): MarkdownDocument {
  const normalizedSource = source.replace(/\r\n?/g, "\n");
  const progressiveContents = progressiveBlockContents(normalizedSource);
  const blocks = makeBlocks(
    progressiveContents ?? (normalizedSource ? [normalizedSource] : []),
  );
  const outline = buildOutline(normalizedSource).map((heading) => ({
    ...heading,
    blockIndex: findBlockIndexForSourceLine(blocks, heading.sourceLine),
  }));

  return {
    source: normalizedSource,
    blocks,
    outline,
    progressive: progressiveContents !== null,
  };
}

export function findBlockIndexForSourceLine(
  blocks: readonly MarkdownDocumentBlock[],
  sourceLine: number,
): number {
  if (blocks.length === 0) return -1;
  if (!Number.isFinite(sourceLine) || sourceLine <= blocks[0].startLine) {
    return sourceLine === Number.POSITIVE_INFINITY ? blocks.length - 1 : 0;
  }

  let low = 0;
  let high = blocks.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (blocks[middle].endLine >= sourceLine) high = middle;
    else low = middle + 1;
  }
  return low;
}
