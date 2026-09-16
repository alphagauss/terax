/** 本文件用 WebView 自带的文本查找能力枚举并导航 Markdown 正文命中。 */

type HighlightRegistry = {
  delete: (name: string) => boolean;
  get: (name: string) => object | undefined;
  set: (name: string, highlight: object) => void;
};

export type BrowserFindWindow = Window & {
  find?: (
    query: string,
    caseSensitive?: boolean,
    backwards?: boolean,
    wrapAround?: boolean,
    wholeWord?: boolean,
    searchInFrames?: boolean,
    showDialog?: boolean,
  ) => boolean;
  Highlight?: new (...ranges: Range[]) => object;
  CSS?: { highlights?: HighlightRegistry };
};

export type RenderedFindSession = {
  query: string;
  ranges: readonly Range[];
  active: Range | null;
  /** 当前命中位于缓存范围内时的从零开始索引，超出上限时为 null。 */
  current: number | null;
  limited: boolean;
};

export type RenderedFindHighlights = {
  ownerWindow: BrowserFindWindow;
  matches: object | null;
  current: object | null;
};

export const RENDERED_FIND_MATCH_LIMIT = 999;
const MATCHES_HIGHLIGHT = "terax-markdown-find-matches";
const CURRENT_HIGHLIGHT = "terax-markdown-find-current";

export function emptyRenderedFindSession(query = ""): RenderedFindSession {
  return { query, ranges: [], active: null, current: null, limited: false };
}

function blurActiveElement(root: HTMLElement): void {
  const activeElement = root.ownerDocument.activeElement;
  if (activeElement && "blur" in activeElement) {
    (activeElement as HTMLElement).blur();
  }
}

function placeSelectionAt(root: HTMLElement, end: boolean): void {
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.collapse(!end);
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeSelectionOn(root: HTMLElement, range: Range | null): boolean {
  if (!range || !root.contains(range.commonAncestorContainer)) return false;
  const selection = root.ownerDocument.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export function selectionBelongsTo(root: HTMLElement): boolean {
  const selection = root.ownerDocument.getSelection();
  return Boolean(
    selection?.anchorNode &&
      selection.focusNode &&
      root.contains(selection.anchorNode) &&
      root.contains(selection.focusNode),
  );
}

function readSelectionRange(root: HTMLElement): Range | null {
  const selection = root.ownerDocument.getSelection();
  return selection?.rangeCount && selectionBelongsTo(root)
    ? selection.getRangeAt(0).cloneRange()
    : null;
}

function sameRange(left: Range, right: Range): boolean {
  return (
    left.startContainer === right.startContainer &&
    left.startOffset === right.startOffset &&
    left.endContainer === right.endContainer &&
    left.endOffset === right.endOffset
  );
}

function browserFind(
  ownerWindow: BrowserFindWindow,
  query: string,
  backwards: boolean,
): boolean {
  return Boolean(
    ownerWindow.find?.call(
      ownerWindow,
      query,
      false,
      backwards,
      false,
      false,
      false,
      false,
    ),
  );
}

/** 枚举浏览器在正文内识别的命中，并缓存有限数量的 Range。 */
export function collectRenderedFindSession(
  root: HTMLElement,
  query: string,
  limit = RENDERED_FIND_MATCH_LIMIT,
): RenderedFindSession {
  const ownerWindow = root.ownerDocument.defaultView as BrowserFindWindow;
  if (!ownerWindow?.find || !query || limit <= 0) {
    return emptyRenderedFindSession(query);
  }

  blurActiveElement(root);
  placeSelectionAt(root, false);
  const ranges: Range[] = [];
  while (ranges.length < limit && browserFind(ownerWindow, query, false)) {
    const range = readSelectionRange(root);
    if (!range) break;
    const previous = ranges[ranges.length - 1];
    if (previous && sameRange(previous, range)) break;
    ranges.push(range);
  }

  let limited = false;
  if (ranges.length === limit && browserFind(ownerWindow, query, false)) {
    limited = readSelectionRange(root) !== null;
  }

  const active = ranges[0] ?? null;
  if (active) placeSelectionOn(root, active);
  else placeSelectionAt(root, false);
  return {
    query,
    ranges,
    active,
    current: active ? 0 : null,
    limited,
  };
}

/** 在正文边界内执行一次浏览器查找，并在越界后从另一端回绕。 */
export function findRenderedText(
  root: HTMLElement,
  query: string,
  backwards: boolean,
  current: Range | null,
): Range | null {
  const ownerWindow = root.ownerDocument.defaultView as BrowserFindWindow;
  if (!ownerWindow?.find || !query) return null;
  blurActiveElement(root);
  if (!placeSelectionOn(root, current)) placeSelectionAt(root, backwards);
  if (browserFind(ownerWindow, query, backwards)) {
    const match = readSelectionRange(root);
    if (match) return match;
  }
  placeSelectionAt(root, backwards);
  if (browserFind(ownerWindow, query, backwards)) {
    const match = readSelectionRange(root);
    if (match) return match;
  }
  placeSelectionAt(root, backwards);
  return null;
}

/** 优先在缓存结果间导航，超过统计上限后继续交给浏览器查找。 */
export function navigateRenderedFindSession(
  root: HTMLElement,
  session: RenderedFindSession,
  backwards: boolean,
): RenderedFindSession {
  if (!session.active || session.ranges.length === 0) return session;
  if (session.current !== null) {
    const next = session.current + (backwards ? -1 : 1);
    if (next >= 0 && next < session.ranges.length) {
      return { ...session, active: session.ranges[next], current: next };
    }
    if (!session.limited) {
      const current = backwards ? session.ranges.length - 1 : 0;
      return { ...session, active: session.ranges[current], current };
    }
  }

  const active = findRenderedText(
    root,
    session.query,
    backwards,
    session.active,
  );
  if (!active) return session;
  const current = session.ranges.findIndex((range) => sameRange(range, active));
  return { ...session, active, current: current >= 0 ? current : null };
}

/** 注册全部匹配和当前匹配的高亮，不影响搜索输入框焦点。 */
export function setRenderedFindHighlights(
  ownerWindow: Window,
  ranges: readonly Range[],
  current: Range | null,
): RenderedFindHighlights | null {
  const browserWindow = ownerWindow as BrowserFindWindow;
  const registry = browserWindow.CSS?.highlights;
  if (!browserWindow.Highlight || !registry || ranges.length === 0) return null;
  const matches = new browserWindow.Highlight(...ranges);
  const active = current ? new browserWindow.Highlight(current) : null;
  registry.set(MATCHES_HIGHLIGHT, matches);
  if (active) registry.set(CURRENT_HIGHLIGHT, active);
  return { ownerWindow: browserWindow, matches, current: active };
}

/** 只清理由当前调用方登记的高亮，避免后台标签误删前台命中。 */
export function clearRenderedFindHighlights(
  highlights: RenderedFindHighlights | null,
): void {
  if (!highlights) return;
  const registry = highlights.ownerWindow.CSS?.highlights;
  if (registry?.get(MATCHES_HIGHLIGHT) === highlights.matches) {
    registry.delete(MATCHES_HIGHLIGHT);
  }
  if (registry?.get(CURRENT_HIGHLIGHT) === highlights.current) {
    registry.delete(CURRENT_HIGHLIGHT);
  }
}

/** 当前命中不可见时，仅滚动 Markdown 自身容器并将其置于视口中部。 */
export function revealRenderedFindRange(
  container: HTMLElement,
  range: Range | null,
): void {
  if (!range) return;
  const match = range.getBoundingClientRect();
  const viewport = container.getBoundingClientRect();
  const top = viewport.top + 40;
  const bottom = viewport.bottom - 12;
  if (match.top >= top && match.bottom <= bottom) return;
  container.scrollTop +=
    match.top + match.height / 2 - (viewport.top + viewport.height / 2);
}
