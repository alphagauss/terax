/**
 * 本文件测试 AI 会话 Markdown 正文的流式与完成态渲染边界。
 * 重点锁定渲染器不得把行内代码中的标记误判为跨段强调并虚构尾随字符。
 */

// @vitest-environment happy-dom

import { MessageResponse } from "@/components/ai-elements/message";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

const MARKDOWN_WITH_CODE_MARKERS = [
  "## 文件与代码操作",
  "",
  "- **find_files**：支持 glob 模式（如 `**/*.ts`）。",
  "",
  "## 说明",
  "",
  "- 当前环境是 **Windows Local**。",
  "",
  "需要我用其中某个工具做什么吗？",
].join("\n");

function renderResponse(streaming: boolean) {
  const container = document.createElement("div");
  const root = createRoot(container);

  act(() => {
    root.render(
      <MessageResponse streaming={streaming}>
        {MARKDOWN_WITH_CODE_MARKERS}
      </MessageResponse>,
    );
  });

  return { container, root };
}

describe("MessageResponse", () => {
  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it.each([true, false])(
    "does not invent Markdown markers when streaming is %s",
    (streaming) => {
      const { container, root } = renderResponse(streaming);

      try {
        expect(container.querySelector("code")?.textContent).toBe("**/*.ts");
        expect(
          container.querySelector('[data-streamdown="strong"]')?.textContent,
        ).toBe("find_files");
        expect(container.textContent).toContain("Windows Local");
        expect(container.textContent).toContain(
          "需要我用其中某个工具做什么吗？",
        );
        expect(container.textContent).not.toContain("吗？**");
        expect(Boolean(container.querySelector("[data-sd-animate]"))).toBe(
          streaming,
        );
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it("updates presentation props when the message text is unchanged", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      act(() => {
        root.render(
          <MessageResponse className="before">相同正文</MessageResponse>,
        );
      });
      expect(container.firstElementChild?.classList.contains("before")).toBe(
        true,
      );

      act(() => {
        root.render(
          <MessageResponse className="after">相同正文</MessageResponse>,
        );
      });
      expect(container.firstElementChild?.classList.contains("after")).toBe(
        true,
      );
      expect(container.firstElementChild?.classList.contains("before")).toBe(
        false,
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
