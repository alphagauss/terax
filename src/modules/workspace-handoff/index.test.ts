/**
 * 本文件测试工作页跨窗口描述的白名单边界。
 * 锁定未保存正文和进程内页面不会进入运行时交换文件，终端只复制可重建启动信息。
 */

import type { Tab } from "@/modules/workbench";
import { describe, expect, it } from "vitest";
import { workspacePageFromTab } from "./index";

const base = { id: 1, spaceId: "default", title: "page" };

describe("Workspace page handoff", () => {
  it("serializes a saved editor without runtime identity", () => {
    expect(
      workspacePageFromTab({
        ...base,
        kind: "editor",
        path: "C:/repo/main.ts",
        dirty: false,
        preview: false,
        explorerRoot: "C:/repo",
      }),
    ).toEqual({
      kind: "editor",
      path: "C:/repo/main.ts",
      explorerRoot: "C:/repo",
    });
  });

  it("rejects dirty documents and process-owned pages", () => {
    expect(
      workspacePageFromTab({
        ...base,
        kind: "markdown",
        path: "/repo/readme.md",
        dirty: true,
        preview: false,
      }),
    ).toBe("dirty");
    expect(
      workspacePageFromTab({
        ...base,
        kind: "ai-diff",
        sessionId: "session",
        path: "/repo/main.ts",
        originalContent: "old",
        proposedContent: "new",
        requestKey: "request",
        status: "pending",
        isNewFile: false,
      }),
    ).toBe("unsupported");
  });

  it("copies only terminal reconstruction inputs", () => {
    const terminal: Tab = {
      ...base,
      kind: "terminal",
      cwd: "/repo",
      blocks: true,
      customTitle: "server",
    };
    expect(workspacePageFromTab(terminal)).toEqual({
      kind: "terminal",
      cwd: "/repo",
      blocks: true,
      customTitle: "server",
    });
    expect(workspacePageFromTab({ ...terminal, private: true })).toBe(
      "unsupported",
    );
  });
});
