// @vitest-environment happy-dom

/**
 * 本文件测试标签栏控件的结构约束和文件路径菜单的复制行为。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { TabBar } from "./TabBar";

const copy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: copy }));
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
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      copy.mockClear();
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const noop = () => {};
      try {
        await act(async () =>
          root.render(
            createElement(TabBar, {
              groupId: 1,
              tabs: [
                {
                  kind,
                  id: 1,
                  spaceId: "default",
                  title: "file",
                  path: filePath,
                  explorerRoot,
                  copyPathRoot,
                  dirty: false,
                  preview: true,
                },
              ],
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
              onRunPythonFile: noop,
              onAttachFileToAgent: noop,
              onPin: noop,
              onRename: noop,
              onDropTab: noop,
              onSplitTab: noop,
            }),
          ),
        );
        await act(async () => {
          container
            .querySelector('[role="tab"]')
            ?.dispatchEvent(
              new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
            );
        });
        const item = Array.from(
          document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
        ).find((item) => item.textContent === "explorer:menu.copyRelativePath");
        expect(item).toBeDefined();
        await act(async () => item?.click());
        if (relativePath) {
          expect(copy).toHaveBeenCalledExactlyOnceWith(relativePath);
        } else {
          expect(item?.getAttribute("aria-disabled")).toBe("true");
          expect(copy).not.toHaveBeenCalled();
        }
      } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      }
    },
  );
});
