/**
 * 本文件测试 Explorer 后台根目录候选与最旧目录选择。
 * 重点锁定路径去重、当前根排除和跨平台路径身份。
 */

import type { Tab } from "@/modules/workbench";
import {
  collectBackgroundExplorerRoots,
  pickNextExplorerRoot,
} from "@/modules/explorer/lib/useExplorerDirectoryPrefetch";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ IS_WINDOWS: true }));

describe("Explorer directory prefetch", () => {
  it("收集终端和文档的显式根目录并排除当前根", () => {
    const tabs: Tab[] = [
      {
        id: 1,
        kind: "terminal",
        spaceId: "a",
        title: "current",
        cwd: "C:\\Work\\Current",
      },
      {
        id: 2,
        kind: "terminal",
        spaceId: "a",
        title: "other",
        cwd: "C:\\Work\\Other",
      },
      {
        id: 3,
        kind: "editor",
        spaceId: "a",
        title: "main.ts",
        path: "C:/Work/Other/main.ts",
        explorerRoot: "c:/work/other",
        dirty: false,
        preview: false,
      },
      {
        id: 4,
        kind: "markdown",
        spaceId: "a",
        title: "README.md",
        path: "C:/Docs/README.md",
        dirty: false,
      },
    ];

    expect(
      collectBackgroundExplorerRoots(tabs, "c:/work/current", {
        kind: "local",
      }),
    ).toEqual(["C:\\Work\\Other"]);
  });

  it("失败或成功后都轮询下一个目录", () => {
    const roots = ["/a", "/b", "/c"];
    expect(pickNextExplorerRoot(roots, null)).toBe("/a");
    expect(pickNextExplorerRoot(roots, "/a")).toBe("/b");
    expect(pickNextExplorerRoot(roots, "/c")).toBe("/a");
    expect(pickNextExplorerRoot(roots, "/removed")).toBe("/a");
  });
});
