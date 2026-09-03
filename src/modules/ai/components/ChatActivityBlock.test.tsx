/**
 * 本文件测试聊天活动块的本地折叠和标题稳定规则。
 * 测试锁定活动结束时只自动收起一次，以及运行中的工具标题至少保持一秒。
 */

// @vitest-environment happy-dom

import { preloadEn } from "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ChatActivityBlock,
  type ChatActivityHeadline,
} from "./ChatActivityBlock";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
const thinking = {
  kind: "thinking",
  key: "thinking",
  text: "Thinking",
} as const;
let container: HTMLDivElement;
let root: Root;

describe("ChatActivityBlock", () => {
  beforeAll(async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    await preloadEn();
  });

  afterAll(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  beforeEach(() => {
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("auto-collapses once when processing completes", () => {
    renderBlock(root, thinking, true, 1250);
    let trigger = container.querySelector("button");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    act(() => trigger?.click());
    expect(container.textContent).toContain("activity detail");

    renderBlock(root, thinking, false, 1250);
    trigger = container.querySelector("button");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Processed for 2s");

    act(() => trigger?.click());
    renderBlock(root, thinking, false, 1250);
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
  });

  it("holds a running tool headline for at least one second", () => {
    vi.useFakeTimers();
    renderBlock(root, { kind: "tool", key: "first", text: "Read a.ts" }, true);
    renderBlock(
      root,
      { kind: "tool", key: "second", text: "Run pnpm test" },
      true,
    );
    expect(container.textContent).toContain("Read a.ts");
    expect(container.textContent).not.toContain("Run pnpm test");

    act(() => vi.advanceTimersByTime(1000));
    expect(container.textContent).toContain("Run pnpm test");
  });
});

function renderBlock(
  root: Root,
  headline: ChatActivityHeadline,
  running: boolean,
  durationMs?: number,
) {
  act(() => {
    root.render(
      <ChatActivityBlock
        durationMs={durationMs}
        headline={headline}
        running={running}
      >
        <div>activity detail</div>
      </ChatActivityBlock>,
    );
  });
}
