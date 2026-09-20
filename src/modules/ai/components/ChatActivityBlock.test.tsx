/**
 * 本文件测试聊天活动块的本地折叠、标题稳定和运行计时规则。
 * 测试锁定活动结束时只自动收起一次、工具标题至少保持一秒，且计时可跨工具与重新挂载恢复。
 */

// @vitest-environment happy-dom

import { preloadEn } from "@/i18n";
import { useChatStore } from "@/modules/ai/store/chatStore";
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
    useChatStore.setState({ agentMetaBySession: {} });
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

  it("reveals a ready summary immediately and completes a short call without delay", () => {
    vi.useFakeTimers();
    renderBlock(root, null, true);
    expect(container.querySelector("button")).toBeNull();
    act(() => vi.advanceTimersByTime(100));
    const command = { kind: "tool", key: "shell", text: "Get-Date" } as const;
    renderBlock(root, command, true);
    expect(container.textContent).toContain("Get-Date");
    renderBlock(
      root,
      { ...command, text: "Get-Date -Format yyyy-MM-dd" },
      true,
    );
    expect(container.textContent).toContain("Get-Date -Format yyyy-MM-dd");
    renderBlock(root, command, false, 200);
    expect(container.textContent).toContain("Processed for 1s");
    expect(container.textContent).not.toContain("Get-Date");
  });

  it("updates the same call without restarting the interval and skips intermediate calls", () => {
    vi.useFakeTimers();
    const first = { kind: "tool", key: "first", text: "pnpm" } as const;
    renderBlock(root, first, true);
    act(() => vi.advanceTimersByTime(400));
    renderBlock(root, { ...first, text: "pnpm test" }, true);
    expect(container.textContent).toContain("pnpm test");
    renderBlock(
      root,
      { kind: "tool", key: "second", text: "second command" },
      true,
    );
    act(() => vi.advanceTimersByTime(300));
    renderBlock(
      root,
      { kind: "tool", key: "third", text: "latest command" },
      true,
    );
    act(() => vi.advanceTimersByTime(299));
    expect(container.textContent).toContain("pnpm test");
    act(() => vi.advanceTimersByTime(1));
    expect(container.textContent).toContain("latest command");
    expect(container.textContent).not.toContain("second command");
  });

  it("keeps thinking until the tool summary is ready without an intermediate label", () => {
    vi.useFakeTimers();
    renderBlock(root, thinking, true);
    renderBlock(root, null, true);
    act(() => vi.advanceTimersByTime(1200));
    expect(container.querySelector("button")?.textContent).toContain(
      "Thinking 2s",
    );
    renderBlock(
      root,
      { kind: "tool", key: "shell", action: "Running", text: "pnpm test" },
      true,
    );
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("pnpm test");
    expect(container.textContent).not.toContain("Thinking");
  });

  it("discards an older candidate and retains the shown tool while the latest input is incomplete", () => {
    vi.useFakeTimers();
    renderBlock(
      root,
      { kind: "tool", key: "first", text: "first command" },
      true,
    );
    renderBlock(
      root,
      { kind: "tool", key: "second", text: "obsolete command" },
      true,
    );
    renderBlock(root, null, true);
    act(() => vi.advanceTimersByTime(1200));
    expect(container.textContent).toContain("first command");
    expect(container.textContent).not.toContain("obsolete command");
    renderBlock(
      root,
      { kind: "tool", key: "third", text: "latest command" },
      true,
    );
    expect(container.textContent).toContain("latest command");
  });

  it("discards a queued headline when the activity completes", () => {
    vi.useFakeTimers();
    renderBlock(
      root,
      { kind: "tool", key: "first", text: "first command" },
      true,
    );
    const pending = {
      kind: "tool",
      key: "second",
      text: "pending command",
    } as const;
    renderBlock(root, pending, true);
    renderBlock(root, pending, false, 200);
    expect(container.textContent).toContain("Processed for 1s");
    act(() => vi.advanceTimersByTime(1000));
    expect(container.textContent).not.toContain("pending command");
    renderBlock(root, thinking, true);
    expect(container.textContent).toContain("Thinking");
  });

  it("keeps the action separate from the truncating summary and updates it in place", () => {
    const headline = {
      kind: "tool",
      key: "file",
      action: "Read",
      text: "src/app.tsx",
    } as const;
    renderBlock(root, headline, true);
    const shimmer = container.querySelector(".terax-shimmer");
    const action = container.querySelector(".shrink-0.whitespace-nowrap");
    const summary = container.querySelector(".truncate.font-mono");
    expect(container.querySelectorAll(".terax-shimmer")).toHaveLength(1);
    expect(action?.textContent).toBe("Read");
    expect(summary?.textContent).toBe("src/app.tsx");
    renderBlock(root, { ...headline, action: "Write" }, true);
    expect(container.querySelector(".terax-shimmer")).toBe(shimmer);
    expect(
      container.querySelector(".shrink-0.whitespace-nowrap")?.textContent,
    ).toBe("Write");
  });

  it("keeps the activity timer across tools and remounts within the session", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    renderBlock(root, thinking, true);
    expect(container.textContent).toContain("Thinking 1s");

    act(() => vi.advanceTimersByTime(2000));
    expect(container.textContent).toContain("Thinking 3s");

    renderBlock(root, { kind: "tool", key: "shell", text: "pnpm test" }, true);
    expect(container.textContent).toContain("pnpm test");
    act(() => vi.advanceTimersByTime(3000));
    renderBlock(root, thinking, true);
    expect(container.textContent).toContain("Thinking 6s");

    act(() => root.render(null));
    renderBlock(root, thinking, true);
    expect(container.textContent).toContain("Thinking 6s");

    renderBlock(root, thinking, true, undefined, "next-activity");
    expect(container.textContent).toContain("Thinking 1s");

    renderBlock(root, thinking, false, 1000, "next-activity");
    expect(
      useChatStore.getState().agentMetaBySession.session?.activityTiming,
    ).toBeUndefined();
  });
});

function renderBlock(
  root: Root,
  headline: ChatActivityHeadline,
  running: boolean,
  durationMs?: number,
  activityKey = "activity",
) {
  act(() => {
    root.render(
      <ChatActivityBlock
        key={activityKey}
        sessionId="session"
        activityKey={activityKey}
        durationMs={durationMs}
        headline={headline}
        running={running}
      >
        <div>activity detail</div>
      </ChatActivityBlock>,
    );
  });
}
