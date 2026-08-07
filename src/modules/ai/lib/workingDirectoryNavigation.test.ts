/**
 * 本文件测试 AI 历史会话工作目录的导航决策。
 * 测试锁定静默返回、跨 Space 查找和各环境的路径身份规则。
 */

import type { Tab } from "@/modules/workbench";
import { describe, expect, it } from "vitest";
import { resolveWorkingDirectoryTarget } from "./workingDirectoryNavigation";

const terminal = (id: number, spaceId: string, cwd: string): Tab => ({
  id,
  kind: "terminal",
  spaceId,
  title: "shell",
  cwd,
});

describe("resolveWorkingDirectoryTarget", () => {
  it("does nothing when Explorer already shows the session directory", () => {
    expect(
      resolveWorkingDirectoryTarget(
        [],
        "C:\\Work\\Repo\\",
        "c:/work/repo",
        { kind: "local" },
        "one",
        true,
      ),
    ).toEqual({ kind: "none" });
  });

  it("prefers a matching terminal in the active Space", () => {
    const tabs = [
      terminal(1, "other", "/work"),
      terminal(2, "active", "/work/"),
    ];
    expect(
      resolveWorkingDirectoryTarget(
        tabs,
        "/elsewhere",
        "/work",
        { kind: "wsl", distro: "Ubuntu" },
        "active",
        false,
      ),
    ).toEqual({ kind: "tab", tabId: 2 });
  });

  it("finds a terminal in another Space before creating one", () => {
    expect(
      resolveWorkingDirectoryTarget(
        [terminal(4, "other", "/work")],
        "/elsewhere",
        "/work",
        { kind: "ssh", profileId: "server" },
        "active",
        false,
      ),
    ).toEqual({ kind: "tab", tabId: 4 });
  });

  it("activates a document that preserves the target Explorer root", () => {
    const editor: Tab = {
      id: 5,
      kind: "editor",
      spaceId: "other",
      title: "index.ts",
      path: "/work/src/index.ts",
      explorerRoot: "/work",
      dirty: false,
      preview: false,
    };
    expect(
      resolveWorkingDirectoryTarget(
        [editor],
        "/elsewhere",
        "/work",
        { kind: "ssh", profileId: "server" },
        "active",
        false,
      ),
    ).toEqual({ kind: "tab", tabId: 5 });
  });

  it("creates a terminal when no directory matches", () => {
    expect(
      resolveWorkingDirectoryTarget(
        [terminal(1, "active", "/other")],
        "/elsewhere",
        "/work",
        { kind: "local" },
        "active",
        false,
      ),
    ).toEqual({ kind: "new-terminal" });
  });

  it("keeps WSL path matching case-sensitive", () => {
    expect(
      resolveWorkingDirectoryTarget(
        [terminal(1, "active", "/Work")],
        "/elsewhere",
        "/work",
        { kind: "wsl", distro: "Ubuntu" },
        "active",
        true,
      ),
    ).toEqual({ kind: "new-terminal" });
  });
});
