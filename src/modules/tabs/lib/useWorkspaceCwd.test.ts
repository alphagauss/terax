import type { Tab } from "@/modules/workbench";
import { describe, expect, it } from "vitest";
import { resolveExplorerRoot } from "./useWorkspaceCwd";

const terminal = (cwd: string): Tab =>
  ({
    id: 1,
    terminalId: 2,
    kind: "terminal",
    spaceId: "default",
    title: "shell",
    cwd,
  }) as Tab;

describe("resolveExplorerRoot", () => {
  it("restores the sidebar root saved by an active file tab", () => {
    const file = {
      id: 3,
      kind: "editor",
      spaceId: "default",
      title: "index.ts",
      path: "/workspace/src/index.ts",
      explorerRoot: "/workspace",
      dirty: false,
      preview: false,
    } satisfies Tab;

    expect(
      resolveExplorerRoot(file, [terminal("/other"), file], "/other", "/home"),
    ).toBe("/workspace");
  });

  it("keeps an active terminal's cwd authoritative", () => {
    const active = terminal("/workspace");
    expect(resolveExplorerRoot(active, [active], "/other", "/home")).toBe(
      "/workspace",
    );
  });
});
