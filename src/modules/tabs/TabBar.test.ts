/**
 * 本文件测试标签栏关闭控件和新建入口的结构约束。
 * 重点锁定关闭交互，以及标签溢出时新建入口仍固定可见。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
    expect(source).toContain(
      "sticky right-0 z-10 size-7 shrink-0 rounded-md bg-card",
    );
  });
});

describe("TabBar interaction colors", () => {
  it("uses shared active and hover semantics without mode overrides", () => {
    expect(source).toContain("bg-interactive-active shadow-sm");
    expect(source).toContain('"text-muted-foreground hover:text-foreground"');
    expect(source).not.toContain("hover:text-foreground/80");
  });
});

describe("TabBar file actions", () => {
  it("offers only the requested Explorer actions for file tabs", () => {
    expect(source).toContain('tr("explorer:menu.revealInFinder")');
    expect(source).toContain('tr("explorer:menu.copyPath")');
    expect(source).toContain('tr("explorer:menu.copyRelativePath")');
    expect(source).toContain('tr("explorer:menu.attachToAgent")');
    expect(source).toContain("{filePath && (");
  });
});
