// @vitest-environment happy-dom
/**
 * 本文件测试标签与 Explorer 根目录之间的工作区路径解析。
 * 终端标签只通过自身标签 ID 和 cwd 参与解析。
 */

import type { Tab, TerminalTab, WorkbenchState } from "@/modules/workbench";
import { DEFAULT_SPACE_ID } from "@/modules/workbench/types";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/modules/workspace-process", () => ({
  setWorkspaceValue: vi.fn(async () => {}),
  deleteWorkspaceValue: vi.fn(async () => {}),
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));
import { createDefaultSpace, useSpaces } from "@/modules/spaces/lib/useSpaces";
import { resolveExplorerRoot, useWorkspaceCwd } from "./useWorkspaceCwd";

const terminal = (cwd: string): TerminalTab => ({
  id: 1,
  kind: "terminal",
  spaceId: "default",
  title: "shell",
  cwd,
});

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

describe("Space directory following", () => {
  const container = document.createElement("div");
  let root: ReturnType<typeof createRoot> | null = null;
  let result: ReturnType<typeof useWorkspaceCwd>;
  function Harness({
    state,
    spaceId,
  }: {
    state: WorkbenchState;
    spaceId: string;
  }) {
    result = useWorkspaceCwd(state, spaceId, "/home");
    return null;
  }
  function layout(tabs: Tab[]): WorkbenchState {
    const spaces: WorkbenchState["spaces"] = {};
    for (const meta of useSpaces.getState().spaces) {
      const ids = tabs
        .filter((tab) => tab.spaceId === meta.id)
        .map((tab) => tab.id);
      spaces[meta.id] = {
        root: { kind: "group", id: 1, groupId: 2 },
        activeGroupId: 2,
        groups: { 2: { id: 2, tabIds: ids, activeTabId: ids[0] ?? null } },
      };
    }
    return {
      spaces,
      tabs: Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
    };
  }
  async function render(tabs: Tab[], spaceId: string) {
    root ??= createRoot(container);
    await act(async () =>
      root?.render(createElement(Harness, { state: layout(tabs), spaceId })),
    );
  }
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
  });

  it("inherits an existing terminal after restoring with a file active and clears history when emptied", async () => {
    useSpaces.setState({
      spaces: [createDefaultSpace()],
      activeId: DEFAULT_SPACE_ID,
    });
    const file: Tab = {
      id: 2,
      kind: "editor",
      spaceId: DEFAULT_SPACE_ID,
      title: "index.ts",
      path: "/project/index.ts",
      dirty: false,
      preview: false,
    };
    await render([file, terminal("/project/sub")], DEFAULT_SPACE_ID);
    expect(result.inheritedCwdForNewTab()).toBe("/project/sub");
    await render([terminal("/old"), file], DEFAULT_SPACE_ID);
    await render([], DEFAULT_SPACE_ID);
    await render([file], DEFAULT_SPACE_ID);
    expect(result.explorerRoot).toBe("/home");
    expect(result.inheritedCwdForNewTab()).toBe("/home");
  });

  it("isolates following per space, keeps names during cd, and restores fixed empty roots", async () => {
    useSpaces.setState({
      spaces: [createDefaultSpace()],
      activeId: DEFAULT_SPACE_ID,
    });
    const a = useSpaces.getState().create({ name: "a", root: "/work/alpha" });
    const b = useSpaces.getState().create({ name: "b", root: null });
    const ta = { ...terminal("/work/alpha/sub"), spaceId: a.id };
    await render([ta], a.id);
    expect(result.explorerRoot).toBe("/work/alpha");
    await act(async () =>
      useSpaces.getState().setRootLocked(a.id, false, null),
    );
    expect(result.explorerRoot).toBe("/work/alpha/sub");
    await render([{ ...ta, cwd: "/work/beta" }], a.id);
    expect(result.explorerRoot).toBe("/work/beta");
    expect(
      useSpaces.getState().spaces.find((space) => space.id === a.id)?.name,
    ).toBe("alpha");
    await act(async () =>
      useSpaces.getState().setRootLocked(a.id, true, result.rootForSpace(a.id)),
    );
    expect(
      useSpaces.getState().spaces.find((space) => space.id === a.id)?.name,
    ).toBe("beta");
    await render([], a.id);
    expect(result.explorerRoot).toBe("/work/beta");
    expect(result.inheritedCwdForNewTab()).toBe("/work/beta");
    await render([ta], b.id);
    expect(result.explorerRoot).toBeNull();
    expect(result.inheritedCwdForNewTab()).toBe("/home");
    expect(
      useSpaces.getState().spaces.find((space) => space.id === b.id)?.root,
    ).toBeNull();
    const tb = { ...terminal("/other/project"), id: 3, spaceId: b.id };
    await render([ta, tb], b.id);
    expect(result.explorerRoot).toBe("/other/project");
    expect(
      useSpaces.getState().spaces.find((space) => space.id === b.id),
    ).toMatchObject({ root: "/other/project", name: "project" });
    await act(async () =>
      useSpaces.getState().setRootLocked(b.id, false, null),
    );
    await render([ta], b.id);
    expect(result.explorerRoot).toBeNull();
  });
});
