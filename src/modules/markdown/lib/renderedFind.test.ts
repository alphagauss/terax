/** 本文件验证浏览器匹配 Range 的统计、导航、高亮和滚动边界。 */

import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import {
  type BrowserFindWindow,
  clearRenderedFindHighlights,
  collectRenderedFindSession,
  navigateRenderedFindSession,
  revealRenderedFindRange,
  setRenderedFindHighlights,
} from "./renderedFind";

function fixture() {
  const ownerWindow = new Window();
  ownerWindow.document.body.innerHTML = [
    '<main id="root">',
    '<span id="first">match</span>',
    '<span id="second">match</span>',
    '<span id="third">match</span>',
    "</main>",
    '<aside id="outside">match</aside>',
  ].join("");
  const element = (id: string) =>
    ownerWindow.document.querySelector(`#${id}`) as unknown as HTMLElement;
  return {
    ownerWindow,
    root: element("root"),
    first: element("first"),
    second: element("second"),
    third: element("third"),
    outside: element("outside"),
  };
}

function selectText(node: Node): void {
  const document = node.ownerDocument as Document;
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function installFindSequence(
  ownerWindow: Window,
  elements: readonly HTMLElement[],
) {
  let index = 0;
  const find = vi.fn(() => {
    const element = elements[index++];
    if (!element) return false;
    selectText(element.firstChild ?? element);
    return true;
  });
  (ownerWindow as unknown as BrowserFindWindow).find = find;
  return find;
}

describe("rendered Markdown find", () => {
  it("counts browser matches inside the Markdown root", () => {
    const { ownerWindow, root, first, second, outside } = fixture();
    installFindSequence(ownerWindow as unknown as Window, [
      first,
      second,
      outside,
    ]);

    const session = collectRenderedFindSession(root, "match");

    expect(session.ranges).toHaveLength(2);
    expect(session.current).toBe(0);
    expect(session.active?.toString()).toBe("match");
    expect(session.limited).toBe(false);
  });

  it("navigates cached matches in both directions with wrapping", () => {
    const { ownerWindow, root, first, second } = fixture();
    installFindSequence(ownerWindow as unknown as Window, [first, second]);
    const initial = collectRenderedFindSession(root, "match");

    const next = navigateRenderedFindSession(root, initial, false);
    const wrapped = navigateRenderedFindSession(root, next, false);
    const previous = navigateRenderedFindSession(root, wrapped, true);

    expect(next.current).toBe(1);
    expect(wrapped.current).toBe(0);
    expect(previous.current).toBe(1);
  });

  it("marks a capped result set as limited", () => {
    const { ownerWindow, root, first, second } = fixture();
    installFindSequence(ownerWindow as unknown as Window, [first, second]);

    const session = collectRenderedFindSession(root, "match", 1);

    expect(session.ranges).toHaveLength(1);
    expect(session.limited).toBe(true);
  });

  it("registers ordinary and active highlights together", () => {
    const { ownerWindow, root, first, second } = fixture();
    installFindSequence(ownerWindow as unknown as Window, [first, second]);
    const session = collectRenderedFindSession(root, "match");
    const highlights = new Map<string, object>();
    class TestHighlight {
      constructor(readonly ranges: Range[]) {}
    }
    const browserWindow = {
      CSS: { highlights },
      Highlight: TestHighlight,
    } as unknown as BrowserFindWindow;

    const registered = setRenderedFindHighlights(
      browserWindow,
      session.ranges,
      session.active,
    );

    expect(highlights.has("terax-markdown-find-matches")).toBe(true);
    expect(highlights.has("terax-markdown-find-current")).toBe(true);
    clearRenderedFindHighlights(registered);
    expect(highlights.size).toBe(0);
  });

  it("does not clear highlights replaced by another Markdown tab", () => {
    const { ownerWindow, root, first, second } = fixture();
    installFindSequence(ownerWindow as unknown as Window, [first, second]);
    const session = collectRenderedFindSession(root, "match");
    const highlights = new Map<string, object>();
    class TestHighlight {
      constructor(readonly ranges: Range[]) {}
    }
    const browserWindow = {
      CSS: { highlights },
      Highlight: TestHighlight,
    } as unknown as BrowserFindWindow;
    const previous = setRenderedFindHighlights(
      browserWindow,
      session.ranges,
      session.active,
    );
    const current = setRenderedFindHighlights(
      browserWindow,
      session.ranges,
      session.active,
    );

    clearRenderedFindHighlights(previous);
    expect(highlights.size).toBe(2);
    clearRenderedFindHighlights(current);
    expect(highlights.size).toBe(0);
  });

  it("centers a match only when it is outside the visible region", () => {
    const container = {
      scrollTop: 100,
      getBoundingClientRect: () => ({ top: 0, bottom: 400, height: 400 }),
    } as unknown as HTMLElement;
    const outside = {
      getBoundingClientRect: () => ({ top: 700, bottom: 720, height: 20 }),
    } as unknown as Range;
    revealRenderedFindRange(container, outside);
    expect(container.scrollTop).toBe(610);

    const visible = {
      getBoundingClientRect: () => ({ top: 100, bottom: 120, height: 20 }),
    } as unknown as Range;
    revealRenderedFindRange(container, visible);
    expect(container.scrollTop).toBe(610);
  });
});
