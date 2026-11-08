/**
 * 本文件测试标签关闭确认 Hook。
 * 重点锁定批量取消、异步检查期间的新标签，以及文档和终端确认边界。
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
  getTabs: () => Tab[];
  disposeTabs: (ids: readonly number[]) => void;
  onReady: (guards: ReturnType<typeof useTabCloseGuards>) => void;
};

/** 暴露关闭入口，供测试驱动 Hook。 */
function Harness({ getTabs, disposeTabs, onReady }: HarnessProps) {
  onReady(useTabCloseGuards({ getTabs, disposeTabs }));
  return null;
}

const terminalTab: Tab = {
  id: 1,
  kind: "terminal",
  spaceId: "default",
  title: "Shell",
};
const documentTab = {
  id: 2,
  kind: "editor",
  spaceId: "project",
  title: "main.ts",
  path: "/work/main.ts",
  dirty: true,
  preview: false,
} satisfies Tab;

describe("useTabCloseGuards", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  function setup(getTabs: () => Tab[]) {
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    const disposeTabs = vi.fn();
    let guards!: ReturnType<typeof useTabCloseGuards>;
    act(() =>
      root.render(
        createElement(Harness, {
          getTabs,
          disposeTabs,
          onReady: (next) => {
            guards = next;
          },
        }),
      ),
    );
    return { disposeTabs, guards: () => guards };
  }

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    roots.length = 0;
    vi.clearAllMocks();
  });

  it("closes the last ordinary tab in a Space", async () => {
    const tab = {
      id: 1,
      kind: "web-preview",
      spaceId: "default",
      title: "Preview",
      url: "",
    } satisfies Tab;
    const { disposeTabs, guards } = setup(() => [tab]);
    await act(async () => guards().handleClose(tab.id));
    expect(disposeTabs).toHaveBeenCalledExactlyOnceWith([tab.id]);
  });

  it("cancels the whole batch and counts shared dirty documents only once", async () => {
    const tabs: Tab[] = [
      terminalTab,
      documentTab,
      { ...documentTab, id: 3, spaceId: "default" },
      { ...terminalTab, id: 4, spaceId: "project" },
    ];
    const { disposeTabs, guards } = setup(() => tabs);
    terminal.needsCloseConfirmation
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await act(async () => guards().handleCloseAllTabs());

    expect(guards().pendingCloseAllTabs).toEqual({
      tabIds: [1, 2, 3, 4],
      spaces: 2,
      dirtyDocuments: 1,
      terminalsToConfirm: 1,
    });
    expect(disposeTabs).not.toHaveBeenCalled();
    act(() => guards().cancelCloseAllTabs());
    expect(guards().pendingCloseAllTabs).toBeNull();
    expect(disposeTabs).not.toHaveBeenCalled();
  });

  it("keeps a newly opened view and does not discard its shared dirty document", async () => {
    const tabs: Tab[] = [terminalTab, documentTab];
    const { disposeTabs, guards } = setup(() => tabs);
    let finishCheck!: (busy: boolean) => void;
    terminal.needsCloseConfirmation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve;
        }),
    );
    let close!: Promise<void>;
    act(() => {
      close = guards().handleCloseAllTabs();
    });
    expect(guards().checkingAllTabs).toBe(true);
    tabs.push({ ...documentTab, id: 3, spaceId: "default" });
    await act(async () => {
      finishCheck(false);
      await close;
    });

    expect(guards().pendingCloseAllTabs).toBeNull();
    expect(disposeTabs).toHaveBeenCalledExactlyOnceWith([1, 2]);
  });

  it("requires confirmation when terminal status cannot be checked", async () => {
    const tabs = [terminalTab];
    const { disposeTabs, guards } = setup(() => tabs);
    terminal.needsCloseConfirmation.mockRejectedValueOnce(new Error("offline"));

    await act(async () => guards().handleCloseAllTabs());
    expect(guards().pendingCloseAllTabs?.terminalsToConfirm).toBe(1);
    expect(disposeTabs).not.toHaveBeenCalled();

    tabs.push({ ...terminalTab, id: 2 });
    act(() => guards().confirmCloseAllTabs());
    expect(disposeTabs).toHaveBeenCalledExactlyOnceWith([1]);
  });
});
