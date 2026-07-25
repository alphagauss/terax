/**
 * 本文件验证资源管理器条目行的交互状态。
 * 删除中的条目必须保持可见、显示状态反馈，并拒绝打开或选择操作。
 */

// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/spinner", () => ({
  Spinner: () => createElement("span", { "data-spinner": "" }),
}));
vi.mock("@hugeicons/core-free-icons", () => ({ ArrowRight01Icon: {} }));
vi.mock("@hugeicons/react", () => ({ HugeiconsIcon: () => null }));
vi.mock("./InlineInput", () => ({ InlineInput: () => null }));
vi.mock("./lib/gitStatusColor", () => ({ explorerGitTextClass: () => "" }));
vi.mock("./lib/iconResolver", () => ({
  fileIconUrl: () => "file-icon",
  folderIconUrl: () => "folder-icon",
}));

import { EntryRow } from "./TreeRow";

afterEach(() => {
  vi.useRealTimers();
});

describe("EntryRow deleting state", () => {
  it("disables immediately but delays transient status feedback", () => {
    vi.useFakeTimers();
    const onOpenFile = vi.fn();
    const onSelectPath = vi.fn();
    const toggle = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() =>
      root.render(
        createElement(EntryRow, {
          domId: "row",
          path: "/workspace/cache",
          name: "cache",
          isDir: true,
          isExpanded: false,
          isDeleting: true,
          depth: 0,
          actions: {
            toggle,
            beginRename: vi.fn(),
            commitRename: vi.fn(),
            cancelRename: vi.fn(),
          },
          renameInProgress: false,
          isSelected: true,
          isRenaming: false,
          onOpenFile,
          onSelectPath,
          deletingLabel: "删除中",
        }),
      ),
    );

    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.textContent).not.toContain("删除中");
    expect(container.querySelector("[data-spinner]")).toBeNull();

    button?.click();
    expect(toggle).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(onSelectPath).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(159));
    expect(button?.textContent).not.toContain("删除中");
    act(() => vi.advanceTimersByTime(1));
    expect(button?.textContent).toContain("删除中");
    expect(container.querySelector("[data-spinner]")).not.toBeNull();
    act(() => root.unmount());
  });
});
