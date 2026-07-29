/**
 * 本文件测试标签栏关闭控件的结构约束。
 * 重点锁定单标签仍为关闭按钮预留空间，并阻止关闭点击落到标签拖拽层。
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
