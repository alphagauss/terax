/**
 * 本文件测试 Markdown 锁定开关的模式切换与扫光生命周期。
 * 锁定编辑提示必须可重复播放，切换到源码模式时不得残留动画状态。
 */

// @vitest-environment happy-dom

import {
  MarkdownViewToggle,
  type MarkdownViewToggleHandle,
} from "@/modules/markdown/MarkdownViewToggle";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("MarkdownViewToggle", () => {
  it("plays the locked shine once and clears it before switching to editing", () => {
    const handle = createRef<MarkdownViewToggleHandle>();
    const onChange = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <MarkdownViewToggle ref={handle} mode="rendered" onChange={onChange} />,
      );
    });
    const button = container.querySelector("button");
    expect(button?.dataset.locked).toBe("true");

    act(() => handle.current?.showLockedEditingAttempt());
    expect(button?.classList.contains("shine")).toBe(true);

    const animationEnd = new Event("animationend", { bubbles: true });
    Object.defineProperty(animationEnd, "animationName", {
      value: "markdown-view-toggle-shine",
    });
    act(() => button?.dispatchEvent(animationEnd));
    expect(button?.classList.contains("shine")).toBe(false);

    act(() => button?.click());
    expect(onChange).toHaveBeenCalledWith("raw");
  });
});
