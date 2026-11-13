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

vi.mock("@hugeicons/react", () => ({ HugeiconsIcon: () => null }));
vi.mock("./InlineInput", () => ({ InlineInput: () => null }));
vi.mock("./lib/gitStatusColor", () => ({
  explorerGitTextClass: (code: string) => `git-status-${code}`,
}));
vi.mock("./lib/iconResolver", () => ({
  fileIconUrl: () => "file-icon",
  folderIconUrl: () => "folder-icon",
}));

import { EntryRow } from "./TreeRow";

afterEach(() => {
  vi.useRealTimers();
});

function renderEntryRow(
  overrides: Partial<Parameters<typeof EntryRow>[0]> = {},
) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(EntryRow, {
        domId: "row",
        path: "/workspace/file.ts",
        name: "file.ts",
        isDir: false,
        isExpanded: false,
        isDeleting: false,
        depth: 0,
        actions: {
          toggle: vi.fn(),
          beginRename: vi.fn(),
          commitRename: vi.fn(),
          cancelRename: vi.fn(),
        },
        renameInProgress: false,
        isSelected: false,
        isRenaming: false,
        onOpenFile: vi.fn(),
        onSelectPath: vi.fn(),
        deletingLabel: "删除中",
        ...overrides,
      }),
    ),
  );
  return { container, root };
}

describe("EntryRow Git decorations", () => {
  it("uses the shared interaction color for hover feedback", () => {
    const { container, root } = renderEntryRow();

    expect(container.querySelector("button")?.className).toContain(
      "hover:bg-interactive-hover",
    );
    act(() => root.unmount());
  });

  it.each(["A", "M", "D", "R", "U"] as const)(
    "keeps the %s color and trailing marker when selected",
    (gitStatusCode) => {
      const { container, root } = renderEntryRow({
        gitStatusCode,
        isSelected: true,
      });

      const decorations = container.querySelectorAll(
        `.git-status-${gitStatusCode}`,
      );
      expect(decorations).toHaveLength(2);
      expect(decorations[0]?.textContent).toBe("file.ts");
      expect(decorations[0]?.classList.contains("truncate")).toBe(true);
      expect(decorations[1]?.textContent).toBe(gitStatusCode);
      expect(decorations[1]?.classList.contains("shrink-0")).toBe(true);
      act(() => root.unmount());
    },
  );

  it.each([
    ["selected", { isSelected: true }, "bg-primary/12"],
    ["last selected", { isLastSelected: true }, "bg-interactive-hover"],
    [
      "the context-menu target",
      { isContextTarget: true },
      "bg-interactive-active",
    ],
  ] as const)(
    "keeps ignored text muted when %s",
    (_, state, backgroundClass) => {
      const { container, root } = renderEntryRow({
        gitignored: true,
        ...state,
      });

      const button = container.querySelector("button");
      expect(button?.classList.contains("text-muted-foreground")).toBe(true);
      expect(button?.classList.contains("text-foreground")).toBe(false);
      expect(button?.classList.contains(backgroundClass)).toBe(true);
      act(() => root.unmount());
    },
  );

  it("does not add a trailing marker to directories", () => {
    const { container, root } = renderEntryRow({
      isDir: true,
      gitStatusCode: "M",
    });

    expect(container.querySelectorAll(".git-status-M")).toHaveLength(1);
    act(() => root.unmount());
  });
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
    expect(button?.classList.contains("text-muted-foreground")).toBe(true);
    expect(button?.classList.contains("text-foreground")).toBe(false);
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
