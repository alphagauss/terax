/**
 * 本文件测试聊天推理分段的自动收起边界。
 * 测试锁定推理完成后等待后继输出，并在后继内容出现时立即收起且允许用户重开。
 */

// @vitest-environment happy-dom

import "@/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { progressiveTextStore } from "@/modules/ai/lib/progressiveText";
import { ChatReasoningPart } from "./ChatReasoningPart";
import { ChatDisplayContext } from "@/modules/ai/hooks/chatDisplay";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe("ChatReasoningPart", () => {
  it("侧栏隐藏时取消渐进任务并保留展开状态", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const clear = vi.spyOn(progressiveTextStore, "clear");
    const target = vi.spyOn(progressiveTextStore, "setTarget");
    const render = (active: boolean, text: string) =>
      act(() =>
        root.render(
          <ChatDisplayContext value={active}>
            <ChatReasoningPart text={text} isStreaming autoCollapse={false} />
          </ChatDisplayContext>,
        ),
      );
    try {
      render(true, "first");
      const button = container.querySelector("button");
      target.mockClear();
      render(false, "first");
      expect(clear).toHaveBeenCalled();
      expect(target).not.toHaveBeenCalled();
      render(true, "first and latest");
      expect(container.querySelector("button")).toBe(button);
      expect(button?.getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("first and latest");
    } finally {
      act(() => root.unmount());
      clear.mockRestore();
      target.mockRestore();
    }
  });
  it("stops progressive work while collapsed and resumes at the current text", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const target = vi.spyOn(progressiveTextStore, "setTarget");
    try {
      act(() =>
        root.render(
          <ChatReasoningPart text="first" isStreaming autoCollapse={false} />,
        ),
      );
      const button = container.querySelector("button");
      act(() => button?.click());
      target.mockClear();
      act(() =>
        root.render(
          <ChatReasoningPart
            text="first and latest"
            isStreaming
            autoCollapse={false}
          />,
        ),
      );
      expect(target).not.toHaveBeenCalled();
      act(() => button?.click());
      expect(container.textContent).toContain("first and latest");
    } finally {
      act(() => root.unmount());
      target.mockRestore();
    }
  });
  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("collapses when following output appears and remains user-expandable", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      act(() => {
        root.render(
          <ChatReasoningPart
            text="检查上下文"
            durationMs={1250}
            isStreaming={false}
            autoCollapse={false}
          />,
        );
      });
      const trigger = container.querySelector("button");
      expect(trigger?.getAttribute("aria-expanded")).toBe("true");

      act(() => {
        root.render(
          <ChatReasoningPart
            text="检查上下文"
            durationMs={1250}
            isStreaming={false}
            autoCollapse
          />,
        );
      });
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");

      act(() => trigger?.click());
      expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    } finally {
      act(() => root.unmount());
    }
  });

  it("stops the shimmer and thinking title when the run stops", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      act(() => {
        root.render(
          <ChatReasoningPart
            text="检查上下文"
            isStreaming
            autoCollapse={false}
          />,
        );
      });
      expect(container.textContent).toContain("chat.reasoning.thinking");
      expect(container.querySelector(".terax-shimmer")).not.toBeNull();

      act(() => {
        root.render(
          <ChatReasoningPart
            text="检查上下文"
            isStreaming={false}
            autoCollapse
          />,
        );
      });

      expect(container.textContent).toContain("chat.reasoning.completed");
      expect(container.textContent).not.toContain("chat.reasoning.thinking");
      expect(container.querySelector(".terax-shimmer")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});
