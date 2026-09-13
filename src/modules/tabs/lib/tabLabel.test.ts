/**
 * 本文件测试标签标题和文件路径提示的显示规则。
 * 重点锁定终端标题优先级，以及只有文件类标签才提供路径提示。
 */

import type { Tab, TerminalTab } from "@/modules/workbench";
import { describe, expect, it } from "vitest";
import { filePathFor, labelFor } from "./tabLabel";

function terminalTab(over: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "default",
    title: "shell",
    ...over,
  };
}

describe("labelFor (terminal tabs)", () => {
  it("derives the label from the last cwd segment", () => {
    expect(labelFor(terminalTab({ cwd: "/Users/me/projects/terax-ai" }))).toBe(
      "terax-ai",
    );
  });

  it("falls back to the title when there is no cwd", () => {
    expect(labelFor(terminalTab({ title: "private" }))).toBe("private");
  });

  it("prefers a custom title over the cwd-derived name", () => {
    expect(
      labelFor(
        terminalTab({
          cwd: "/Users/me/projects/terax-ai",
          customTitle: "Server",
        }),
      ),
    ).toBe("Server");
  });

  it("keeps the custom title after the cwd changes (survives cd)", () => {
    const renamed = terminalTab({ cwd: "/Users/me/a", customTitle: "Server" });
    const afterCd = { ...renamed, cwd: "/Users/me/b/c" };
    expect(labelFor(afterCd)).toBe("Server");
  });

  it("handles Windows-style cwd separators", () => {
    expect(labelFor(terminalTab({ cwd: "C:\\Users\\me\\proj" }))).toBe("proj");
  });
});

describe("filePathFor", () => {
  it("returns the absolute path for editor and Markdown tabs", () => {
    const tabs: Tab[] = [
      {
        id: 2,
        kind: "editor",
        spaceId: "default",
        title: "App.tsx",
        path: "/workspace/src/App.tsx",
        dirty: false,
        preview: false,
      },
      {
        id: 3,
        kind: "markdown",
        spaceId: "default",
        title: "README.md",
        path: "/workspace/README.md",
        dirty: false,
        preview: false,
      },
    ];

    expect(tabs.map(filePathFor)).toEqual([
      "/workspace/src/App.tsx",
      "/workspace/README.md",
    ]);
  });

  it("does not expose terminal context paths", () => {
    expect(filePathFor(terminalTab({ cwd: "/workspace" }))).toBeUndefined();
  });
});
