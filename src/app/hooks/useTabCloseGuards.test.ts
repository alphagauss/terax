/**
 * 本文件测试标签关闭确认 Hook。
 * 重点锁定最后一个普通标签可以关闭，同时保留文档和终端确认边界。
 */

// @vitest-environment happy-dom

import type { Tab } from "@/modules/workbench";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTabCloseGuards } from "./useTabCloseGuards";

const terminal = vi.hoisted(() => ({
  needsCloseConfirmation: vi.fn(async () => false),
}));

vi.mock("@/modules/terminal", () => ({
  terminalNeedsCloseConfirmation: terminal.needsCloseConfirmation,
}));

type HarnessProps = {
  tabs: Tab[];
  disposeTab: (id: number) => void;
  onReady: (close: (id: number) => Promise<void>) => void;
};

/** 暴露关闭入口，供测试驱动 Hook。 */
function Harness({ tabs, disposeTab, onReady }: HarnessProps) {
  onReady(useTabCloseGuards({ tabs, disposeTab }).handleClose);
  return null;
}

describe("useTabCloseGuards", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    roots.length = 0;
    vi.clearAllMocks();
  });

  it("closes the last ordinary tab in a Space", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    const disposeTab = vi.fn();
    let close: ((id: number) => Promise<void>) | undefined;
    const tab = {
      id: 1,
      kind: "web-preview",
      spaceId: "default",
      title: "Preview",
      url: "",
    } satisfies Tab;

    await act(async () => {
      root.render(
        createElement(Harness, {
          tabs: [tab],
          disposeTab,
          onReady: (handleClose) => {
            close = handleClose;
          },
        }),
      );
    });
    await act(async () => close?.(tab.id));

    expect(disposeTab).toHaveBeenCalledOnce();
    expect(disposeTab).toHaveBeenCalledWith(tab.id);
  });
});
