/**
 * 本文件测试 Workbench 空间布局的序列化和恢复。
 * 重点锁定可恢复页面只保存定位信息，临时页面和运行时状态不会持久化。
 */

import {
  freshSpaceWorkbench,
  hydrateSpaceWorkbench,
  isSerializedWorkbenchNode,
  type SerializedWorkbenchNode,
  serializeSpaceWorkbench,
} from "@/modules/spaces/lib/serialize";
import type { Tab, WorkbenchState } from "@/modules/workbench";
import { describe, expect, it, vi } from "vitest";

function counter(start = 100): () => number {
  let value = start;
  return () => value++;
}

function state(): WorkbenchState {
  const terminal: Tab = {
    id: 1,
    kind: "terminal",
    spaceId: "default",
    title: "api",
    cwd: "/work/api",
    customTitle: "api",
  };
  const editor: Tab = {
    id: 2,
    kind: "editor",
    spaceId: "default",
    title: "main.ts",
    path: "/work/main.ts",
    explorerRoot: "/work",
    dirty: false,
    preview: false,
  };
  const markdown: Tab = {
    id: 3,
    kind: "markdown",
    spaceId: "default",
    title: "guide.md",
    path: "/work/docs/guide.md",
    explorerRoot: "/work",
    dirty: false,
    preview: false,
  };
  const webPreview: Tab = {
    id: 4,
    kind: "web-preview",
    spaceId: "default",
    title: "localhost:5173",
    url: "http://localhost:5173/docs",
  };
  const blocks: Tab = {
    id: 5,
    kind: "terminal",
    spaceId: "default",
    title: "blocks",
    cwd: "/work/docs",
    blocks: true,
  };
  return {
    tabs: {
      1: terminal,
      2: editor,
      3: markdown,
      4: webPreview,
      5: blocks,
    },
    spaces: {
      default: {
        root: {
          kind: "split",
          id: 20,
          axis: "row",
          sizes: [35, 65],
          children: [
            { kind: "group", id: 21, groupId: 30 },
            {
              kind: "split",
              id: 22,
              axis: "col",
              sizes: [40, 60],
              children: [
                { kind: "group", id: 23, groupId: 31 },
                { kind: "group", id: 24, groupId: 32 },
              ],
            },
          ],
        },
        groups: {
          30: { id: 30, tabIds: [1], activeTabId: 1 },
          31: { id: 31, tabIds: [2, 3, 4], activeTabId: 3 },
          32: { id: 32, tabIds: [5], activeTabId: 5 },
        },
        activeGroupId: 31,
      },
    },
  };
}

describe("Workbench Space serialization", () => {
  it("creates a base page instead of a terminal without an explicit cwd", () => {
    const fresh = freshSpaceWorkbench("default", null, counter());
    expect(fresh.tabs).toEqual([]);
    expect(
      fresh.space.groups[fresh.space.activeGroupId].activeTabId,
    ).toBeNull();
  });

  it("allocates one frontend identity for a terminal tab", () => {
    const allocId = vi.fn(counter());
    const fresh = freshSpaceWorkbench("default", "/work", allocId);
    const tab = fresh.tabs[0];

    expect(tab).toMatchObject({ id: 100, kind: "terminal", cwd: "/work" });
    expect(fresh.space.groups[fresh.space.activeGroupId].activeTabId).toBe(
      tab.id,
    );
    expect(allocId).toHaveBeenCalledTimes(3);
  });

  it("persists Alpha settings as a locator and reloads its runtime page", () => {
    const alphaSettings: Tab = {
      id: 1,
      kind: "alpha-settings",
      spaceId: "default",
      title: "Alpha Settings",
    };
    const current: WorkbenchState = {
      tabs: { 1: alphaSettings },
      spaces: {
        default: {
          root: { kind: "group", id: 2, groupId: 3 },
          groups: {
            3: { id: 3, tabIds: [1], activeTabId: 1 },
          },
          activeGroupId: 3,
        },
      },
    };

    const serialized = serializeSpaceWorkbench(current, "default");
    expect(serialized).toEqual({
      kind: "group",
      tabs: [{ kind: "alpha-settings" }],
      activeTabIndex: 0,
      active: true,
    });
    expect(isSerializedWorkbenchNode(serialized)).toBe(true);

    const restored = serialized
      ? hydrateSpaceWorkbench(serialized, "default", counter())
      : null;
    expect(restored?.tabs).toEqual([
      expect.objectContaining({
        kind: "alpha-settings",
        spaceId: "default",
        cold: true,
      }),
    ]);
  });

  it("persists Alpha workstation, data and backtest pages as runtime locators", () => {
    const current: WorkbenchState = {
      tabs: {
        1: {
          id: 1,
          kind: "alpha-data",
          spaceId: "default",
          title: "Alpha Data",
        },
        2: {
          id: 2,
          kind: "alpha-backtests",
          spaceId: "default",
          title: "Alpha Backtests",
        },
        3: {
          id: 3,
          kind: "alpha-workstation",
          spaceId: "default",
          title: "Alpha Workstation",
        },
      },
      spaces: {
        default: {
          root: { kind: "group", id: 4, groupId: 5 },
          groups: {
            5: { id: 5, tabIds: [1, 2, 3], activeTabId: 3 },
          },
          activeGroupId: 5,
        },
      },
    };

    const serialized = serializeSpaceWorkbench(current, "default");
    expect(serialized).toEqual({
      kind: "group",
      tabs: [
        { kind: "alpha-data" },
        { kind: "alpha-backtests" },
        { kind: "alpha-workstation" },
      ],
      activeTabIndex: 2,
      active: true,
    });

    const restored = serialized
      ? hydrateSpaceWorkbench(serialized, "default", counter())
      : null;
    expect(restored?.tabs.map((tab) => tab.kind)).toEqual([
      "alpha-data",
      "alpha-backtests",
      "alpha-workstation",
    ]);
  });

  it("drops persisted Alpha pages when the current environment hides Alpha", () => {
    const serialized: SerializedWorkbenchNode = {
      kind: "group",
      tabs: [
        { kind: "alpha-workstation" },
        { kind: "alpha-data" },
        { kind: "alpha-backtests" },
        { kind: "alpha-settings" },
        { kind: "terminal", cwd: "/work" },
      ],
      activeTabIndex: 0,
      active: true,
    };

    const restored = hydrateSpaceWorkbench(serialized, "default", counter(), {
      allowAlphaPages: false,
    });

    expect(restored?.tabs).toEqual([
      expect.objectContaining({ kind: "terminal", cwd: "/work" }),
    ]);
    const activeGroup = restored?.space.groups[restored.space.activeGroupId];
    expect(activeGroup?.activeTabId).toBe(restored?.tabs[0]?.id);
  });

  it("round-trips layout, active group, tabs, and terminal cwd", () => {
    const serialized = serializeSpaceWorkbench(state(), "default");
    expect(serialized).toMatchObject({
      kind: "split",
      axis: "row",
      sizes: [35, 65],
    });
    if (!serialized) throw new Error("missing serialized Workbench");
    const restored = hydrateSpaceWorkbench(serialized, "default", counter());
    expect(restored?.space.root).toMatchObject({
      kind: "split",
      axis: "row",
      sizes: [35, 65],
      children: [
        { kind: "group" },
        { kind: "split", axis: "col", sizes: [40, 60] },
      ],
    });
    expect(restored?.tabs.map((tab) => tab.kind)).toEqual([
      "terminal",
      "editor",
      "markdown",
      "web-preview",
      "terminal",
    ]);
    expect(restored?.tabs[0]).toMatchObject({
      kind: "terminal",
      cwd: "/work/api",
      customTitle: "api",
      cold: true,
    });
    const active = restored?.space.groups[restored.space.activeGroupId];
    expect(
      restored?.tabs.find((tab) => tab.id === active?.activeTabId),
    ).toMatchObject({
      kind: "markdown",
      path: "/work/docs/guide.md",
      explorerRoot: "/work",
    });
    expect(restored?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "web-preview",
          url: "http://localhost:5173/docs",
        }),
        expect.objectContaining({
          kind: "terminal",
          blocks: true,
          cwd: "/work/docs",
        }),
      ]),
    );
  });

  it("drops private and transient pages and collapses empty branches", () => {
    const current = state();
    current.tabs[1] = { ...current.tabs[1], private: true } as Tab;
    current.tabs[5] = { ...current.tabs[5], private: true } as Tab;
    const serialized = serializeSpaceWorkbench(current, "default");
    expect(serialized).toMatchObject({ kind: "group" });
  });

  it("preserves retained panel proportions when a transient branch is dropped", () => {
    const first: Tab = {
      id: 1,
      kind: "terminal",
      spaceId: "default",
      title: "one",
    };
    const transient: Tab = {
      id: 2,
      kind: "git-diff",
      spaceId: "default",
      title: "Git Diff",
      path: "file.ts",
      side: "worktree",
      originalPath: null,
      repoRoot: "/work",
      preview: true,
    };
    const last: Tab = {
      id: 3,
      kind: "terminal",
      spaceId: "default",
      title: "three",
    };
    const current: WorkbenchState = {
      tabs: { 1: first, 2: transient, 3: last },
      spaces: {
        default: {
          root: {
            kind: "split",
            id: 10,
            axis: "row",
            sizes: [20, 30, 50],
            children: [
              { kind: "group", id: 11, groupId: 21 },
              { kind: "group", id: 12, groupId: 22 },
              { kind: "group", id: 13, groupId: 23 },
            ],
          },
          groups: {
            21: { id: 21, tabIds: [1], activeTabId: 1 },
            22: { id: 22, tabIds: [2], activeTabId: 2 },
            23: { id: 23, tabIds: [3], activeTabId: 3 },
          },
          activeGroupId: 21,
        },
      },
    };

    const serialized = serializeSpaceWorkbench(current, "default");
    expect(serialized?.kind).toBe("split");
    if (serialized?.kind !== "split") throw new Error("expected split");
    expect(serialized.sizes?.[0]).toBeCloseTo(20 / 0.7);
    expect(serialized.sizes?.[1]).toBeCloseTo(50 / 0.7);
  });

  it("rejects the old flat Space state shape", () => {
    expect(isSerializedWorkbenchNode({ tabs: [], activeTabIndex: 0 })).toBe(
      false,
    );
  });

  it("rejects the old preview discriminator", () => {
    expect(
      isSerializedWorkbenchNode({
        kind: "group",
        tabs: [{ kind: "preview", url: "http://localhost:5173" }],
        activeTabIndex: 0,
      }),
    ).toBe(false);
  });

  it("rejects invalid active flags and panel sizes", () => {
    const group = {
      kind: "group",
      tabs: [{ kind: "terminal" }],
      activeTabIndex: 0,
    };
    expect(isSerializedWorkbenchNode({ ...group, active: "yes" })).toBe(false);
    expect(
      isSerializedWorkbenchNode({
        kind: "split",
        axis: "row",
        children: [group, group],
        sizes: [100, -1],
      }),
    ).toBe(false);
  });
});
