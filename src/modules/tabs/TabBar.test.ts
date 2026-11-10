// @vitest-environment happy-dom

/**
 * 本文件测试标签栏控件的结构约束和文件路径菜单的复制行为。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Tab } from "@/modules/workbench/types";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabBar } from "./TabBar";

const copy = vi.hoisted(() => vi.fn());
const resolveFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: copy }));
vi.mock("@/modules/file-actions/actions", () => ({
  resolveFileReference: resolveFile,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "TabBar.tsx"), "utf8");

describe("TabBar close control", () => {
  it("reserves trailing space whenever the tab can close", () => {
    expect(source).toMatch(/canClose\s+\? "ps-1\.5! pe-6!"/);
    expect(source).toMatch(/canClose\s+\? "ps-2! pe-6!"/);
  });

  it("keeps close pointer events out of tab selection and drag handling", () => {
    expect(source).toContain("event.stopPropagation();");
    expect(source).toContain(
      "onPointerUp={(event) => event.stopPropagation()}",
    );
    expect(source).toContain("onClose(t.id);");
  });
});

describe("TabBar new-tab control", () => {
  it("keeps the new-tab trigger visible at the scrolling edge", () => {
    expect(source).toContain("sticky right-0 z-10 shrink-0 bg-card");
  });
});

describe("TabBar interaction colors", () => {
  it("uses shared active and hover semantics without mode overrides", () => {
    expect(source).toContain("bg-interactive-active shadow-sm");
    expect(source).toContain('"text-muted-foreground hover:text-foreground"');
    expect(source).not.toContain("hover:text-foreground/80");
  });
});

describe("TabBar editor icon", () => {
  it("keeps the file icon passive and does not restore language overrides", () => {
    expect(source).toContain("<TabIcon tab={t} />");
    expect(source).not.toContain("onOverrideLanguage");
    expect(source).not.toContain("showAllLanguages");
  });
});

describe("TabBar file actions", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const openDiffFile = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    copy.mockClear();
    resolveFile.mockReset();
    openDiffFile.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function openMenu() {
    await act(async () => {
      container
        .querySelector('[role="tab"]')
        ?.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
        );
    });
  }

  async function renderTabMenu(tab: Tab) {
    const noop = () => {};
    await act(async () =>
      root.render(
        createElement(TabBar, {
          groupId: 1,
          tabs: [tab],
          activeId: 1,
          activeGroup: true,
          canClose: true,
          onSelect: noop,
          onNew: noop,
          onNewBlock: noop,
          onNewPrivate: noop,
          onNewWebPreview: noop,
          onNewEditor: noop,
          onClose: noop,
          onOpenDiffFile: openDiffFile,
          onRunPythonFile: noop,
          onAttachFileToAgent: noop,
          onPin: noop,
          onRename: noop,
          onDropTab: noop,
          onSplitTab: noop,
        }),
      ),
    );
    await openMenu();
  }

  function menuItem(label: string) {
    return Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === label);
  }

  it("offers only the requested Explorer actions for file tabs", () => {
    expect(source).toContain('tr("common:fileActions.reveal")');
    expect(source).toContain('tr("explorer:menu.copyPath")');
    expect(source).toContain('tr("explorer:menu.copyRelativePath")');
    expect(source).toContain('tr("explorer:menu.attachToAgent")');
    expect(source).toContain("{filePath && (");
  });

  it.each([
    ["editor", "/repo/other", "/repo", "/repo/src/file.ts", "src/file.ts"],
    ["markdown", "/repo/docs", "/repo", "/repo/docs/file.md", "docs/file.md"],
    ["editor", "/repo", undefined, "/repo/src/file.ts", "src/file.ts"],
    ["editor", "/repo/other", undefined, "/repo/src/file.ts", undefined],
  ] as const)(
    "%s 文件标签的文件树根为 %s、复制基准为 %s 时复制相对路径",
    async (kind, explorerRoot, copyPathRoot, filePath, relativePath) => {
      await renderTabMenu({
        kind,
        id: 1,
        spaceId: "default",
        title: "file",
        path: filePath,
        explorerRoot,
        copyPathRoot,
        dirty: false,
        preview: true,
      });
      const item = menuItem("explorer:menu.copyRelativePath");
      expect(item).toBeDefined();
      await act(async () => item?.click());
      if (relativePath) {
        expect(copy).toHaveBeenCalledExactlyOnceWith(relativePath);
      } else {
        expect(item?.getAttribute("aria-disabled")).toBe("true");
        expect(copy).not.toHaveBeenCalled();
      }
    },
  );

  const diffTab = {
    id: 1,
    spaceId: "default",
    title: "file.ts",
    path: "src/file.ts",
    repoRoot: "/repo",
    originalPath: "src/old.ts",
    preview: true,
  };

  const historyTab = {
    ...diffTab,
    kind: "git-commit-file",
    sha: "0123456789abcdef",
    shortSha: "0123456",
    subject: "Rename file",
  } as const;

  it.each([
    [
      "worktree",
      { ...diffTab, kind: "git-diff", side: "worktree" },
      "menu.openFile",
    ],
    ["index", { ...diffTab, kind: "git-diff", side: "index" }, "menu.openFile"],
    ["history", historyTab, "menu.openWorkingFile"],
  ] as const)(
    "opens the current file from a %s diff",
    async (source, tab, label) => {
      resolveFile.mockResolvedValue({
        path: "/repo/src/file.ts",
        isDir: false,
      });
      await renderTabMenu(tab);
      expect(menuItem("common:fileActions.reveal")).toBeDefined();
      expect(Boolean(menuItem("gitHistory:copySha"))).toBe(
        source === "history",
      );
      await act(async () => menuItem(label)?.click());
      expect(openDiffFile).toHaveBeenCalledExactlyOnceWith(
        "/repo/src/file.ts",
        "/repo",
        1,
        1,
      );
    },
  );

  it("copies paths and the full SHA even when the historical file is missing", async () => {
    resolveFile.mockRejectedValue(new Error("missing file"));
    await renderTabMenu(historyTab);
    expect(menuItem("menu.openWorkingFile")).toBeUndefined();
    expect(menuItem("common:fileActions.reveal")).toBeUndefined();
    await act(async () => menuItem("menu.copyAbsolutePath")?.click());
    await openMenu();
    await act(async () => menuItem("menu.copyRelativePath")?.click());
    await openMenu();
    await act(async () => menuItem("gitHistory:copySha")?.click());
    expect(copy.mock.calls).toEqual([
      ["/repo/src/file.ts"],
      ["src/file.ts"],
      ["0123456789abcdef"],
    ]);
  });
});
