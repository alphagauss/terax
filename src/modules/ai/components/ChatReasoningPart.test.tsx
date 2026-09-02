/**
 * 本文件测试聊天推理分段的自动收起边界。
 * 测试锁定推理完成后等待后继输出，并在后继内容出现时立即收起且允许用户重开。
 */

// @vitest-environment happy-dom

import "@/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatReasoningPart } from "./ChatReasoningPart";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe("ChatReasoningPart", () => {
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
});
