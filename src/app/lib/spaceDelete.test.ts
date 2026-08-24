/**
 * 本文件测试 Space 删除时共享文档的生命周期处理。
 * 重点锁定仍有视图的文档不会被丢弃，失去最后视图的脏文档会被正确识别。
 */

import type { Tab } from "@/modules/workbench";
import { describe, expect, it } from "vitest";
import { spaceDeleteDocuments } from "./spaceDelete";

describe("Space deletion document lifecycle", () => {
  it("guards and discards only documents losing their final view", () => {
    const tabs: Tab[] = [
      {
        id: 1,
        kind: "editor",
        spaceId: "deleted",
        title: "shared.ts",
        path: "C:\\work\\shared.ts",
        dirty: true,
        preview: false,
      },
      {
        id: 2,
        kind: "markdown",
        spaceId: "deleted",
        title: "orphan.md",
        path: "C:\\work\\orphan.md",
        dirty: true,
        preview: false,
      },
      {
        id: 3,
        kind: "editor",
        spaceId: "kept",
        title: "shared.ts",
        path: "C:\\work\\shared.ts",
        dirty: true,
        preview: false,
      },
    ];

    expect(spaceDeleteDocuments(tabs, "deleted", { kind: "local" })).toEqual({
      dirtyDocuments: 1,
      discardPaths: ["C:\\work\\orphan.md"],
    });
  });
});
