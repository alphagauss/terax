/**
 * 本文件验证 AI 会话折叠详情的滚动保护。
 * 锁定用户主动查看详情时暂停跟随，尺寸收缩也不得重新激活跟随。
 */

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stickMocks = vi.hoisted(() => ({
  context: {
    scrollRef: { current: null as HTMLDivElement | null },
    state: {
      escapedFromLock: false,
      isAtBottom: true,
    },
    stopScroll: vi.fn(),
  },
}));

vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => stickMocks.context,
}));

import { ChatCollapsibleScrollGuard } from "./ChatCollapsibleScrollGuard";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
let container: HTMLDivElement;
let root: Root;

describe("ChatCollapsibleScrollGuard", () => {
  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    root = createRoot(container);
    stickMocks.context.state.escapedFromLock = false;
    stickMocks.context.state.isAtBottom = true;
    stickMocks.context.stopScroll.mockClear();
    stickMocks.context.stopScroll.mockImplementation(() => {
      stickMocks.context.state.escapedFromLock = true;
      stickMocks.context.state.isAtBottom = false;
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    renderGuard();
  });

  afterEach(() => {
    act(() => root.unmount());
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.restoreAllMocks();
    stickMocks.context.scrollRef.current = null;
  });

  it("pauses following before resizing and after the final collapsed size", () => {
    act(() => trigger().click());

    expect(stickMocks.context.state.escapedFromLock).toBe(true);
    expect(stickMocks.context.state.isAtBottom).toBe(false);

    // 模拟依赖在内容缩短并接近底部时错误恢复跟随。
    stickMocks.context.state.escapedFromLock = false;
    stickMocks.context.state.isAtBottom = true;
    act(() =>
      details().dispatchEvent(new Event("animationend", { bubbles: true })),
    );

    expect(stickMocks.context.state.escapedFromLock).toBe(true);
    expect(stickMocks.context.state.isAtBottom).toBe(false);

    expect(stickMocks.context.stopScroll).toHaveBeenCalledTimes(2);
  });

  it("ignores clicks outside collapsible triggers", () => {
    const unrelated = document.createElement("button");
    stickMocks.context.scrollRef.current?.append(unrelated);
    act(() => unrelated.click());

    expect(stickMocks.context.stopScroll).not.toHaveBeenCalled();
  });
});

function renderGuard() {
  act(() => {
    root.render(
      <div
        ref={(element) => {
          stickMocks.context.scrollRef.current = element;
        }}
      >
        <ChatCollapsibleScrollGuard />
        <button type="button" data-slot="collapsible-trigger">
          Details
        </button>
        <div className="terax-collapsible-content">content</div>
      </div>,
    );
  });
}

function trigger(): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(
    "[data-slot='collapsible-trigger']",
  );
  if (!element) throw new Error("missing collapsible trigger");
  return element;
}

function details(): HTMLDivElement {
  const element = container.querySelector<HTMLDivElement>(
    ".terax-collapsible-content",
  );
  if (!element) throw new Error("missing collapsible content");
  return element;
}
