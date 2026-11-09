/**
 * 本文件测试 Workbench 的纯状态变换。
 * 重点锁定分组布局、跨 Space 移动和唯一空分组的合法边界。
 */

import { describe, expect, it } from "vitest";
import {
  adjacentTabId,
  activateTab,
  addTabToGroup,
  assertWorkbenchState,
  closeTab,
  closeTabs,
  createEmptySpaceWorkbench,
  createSpaceWorkbench,
  groupIds,
  minimumPanelPercent,
  moveTabToGroup,
  patchDocumentDirty,
  patchTab,
  removeGroupNode,
  reorderTabByGap,
  revealTabInState,
  splitWithTab,
  tabsForActiveGroup,
} from "./model";
import type { Tab, WorkbenchLayoutNode, WorkbenchState } from "./types";

function terminal(id: number): Tab {
  return {
    id,
    kind: "terminal",
    spaceId: "default",
    title: `term-${id}`,
  };
}

function initial(): WorkbenchState {
  const tab = terminal(2);
  return {
    tabs: { [tab.id]: tab },
    spaces: { default: createSpaceWorkbench(1, 3, tab.id) },
  };
}

describe("workbench model", () => {
  it("splits around a group and preserves terminal identity", () => {
    const tab = terminal(4);
    const next = splitWithTab(initial(), tab, 1, 4, 5, 6, "right", false);
    expect(groupIds(next.spaces.default.root)).toEqual([1, 4]);
    expect(next.spaces.default.groups[4].tabIds).toEqual([4]);
    expect(next.tabs[4]).toStrictEqual(tab);
    expect(() => assertWorkbenchState(next)).not.toThrow();
  });

  it("warms a cold tab when a split activates it", () => {
    const tab = { ...terminal(4), cold: true };
    const next = splitWithTab(initial(), tab, 1, 4, 5, 6, "right", false);
    expect(next.tabs[4].cold).toBe(false);
  });

  it("moves a tab between groups and collapses an empty source", () => {
    const second = terminal(4);
    const split = splitWithTab(initial(), second, 1, 4, 5, 6, "right", false);
    const moved = moveTabToGroup(split, 2, 4, 1);
    expect(groupIds(moved.spaces.default.root)).toEqual([4]);
    expect(moved.spaces.default.groups[4].tabIds).toEqual([4, 2]);
    expect(() => assertWorkbenchState(moved)).not.toThrow();
  });

  it("warms a cold tab when moving it into an active group", () => {
    const split = splitWithTab(
      initial(),
      terminal(4),
      1,
      4,
      5,
      6,
      "right",
      false,
    );
    const cold = {
      ...split,
      tabs: { ...split.tabs, 2: { ...split.tabs[2], cold: true } },
    } satisfies WorkbenchState;
    const moved = moveTabToGroup(cold, 2, 4);
    expect(moved.tabs[2].cold).toBe(false);
  });

  it("closes the last tab into the Space base page", () => {
    const state = initial();
    const closed = closeTab(state, 2);
    expect(closed.tabs).toEqual({});
    expect(closed.spaces.default.groups[1]).toEqual({
      id: 1,
      tabIds: [],
      activeTabId: null,
    });
    expect(() => assertWorkbenchState(closed)).not.toThrow();
  });

  it("warms the cold fallback tab when closing the active tab", () => {
    const state = initial();
    const active = terminal(4);
    state.tabs[2] = { ...state.tabs[2], cold: true };
    state.tabs[4] = active;
    state.spaces.default.groups[1] = {
      id: 1,
      tabIds: [2, 4],
      activeTabId: 4,
    };

    const closed = closeTab(state, 4);

    expect(closed.spaces.default.groups[1].activeTabId).toBe(2);
    expect(closed.tabs[2].cold).toBe(false);
  });

  it("warms the fallback even when the removed active tab was cold", () => {
    const state = initial();
    state.tabs[2] = { ...state.tabs[2], cold: true };
    state.tabs[4] = { ...terminal(4), cold: true };
    state.spaces.default.groups[1] = {
      id: 1,
      tabIds: [2, 4],
      activeTabId: 4,
    };

    const closed = closeTab(state, 4);

    expect(closed.spaces.default.groups[1].activeTabId).toBe(2);
    expect(closed.tabs[2].cold).toBe(false);
  });

  it("collapses empty split groups and warms only the surviving fallback", () => {
    let state = splitWithTab(
      initial(),
      terminal(4),
      1,
      4,
      5,
      6,
      "right",
      false,
    );
    state = addTabToGroup(state, { ...terminal(7), cold: true }, 4, 0, false);
    state = addTabToGroup(state, { ...terminal(8), cold: true }, 4, 2, false);

    const closed = closeTabs(state, [4, 2]);

    expect(groupIds(closed.spaces.default.root)).toEqual([4]);
    expect(closed.spaces.default.groups[4]).toEqual({
      id: 4,
      tabIds: [7, 8],
      activeTabId: 7,
    });
    expect(closed.tabs[7].cold).toBe(false);
    expect(closed.tabs[8]).toBe(state.tabs[8]);
    assertWorkbenchState(closed);
  });

  it("warms the active page when closing the focused split group", () => {
    let state = splitWithTab(
      initial(),
      terminal(4),
      1,
      4,
      5,
      6,
      "right",
      false,
    );
    state = addTabToGroup(state, terminal(7), 4);
    state.tabs[2] = { ...state.tabs[2], cold: true };

    const closed = closeTabs(state, [4, 7]);

    expect(closed.spaces.default.activeGroupId).toBe(1);
    expect(closed.tabs[2].cold).toBe(false);
    assertWorkbenchState(closed);
  });

  it("allows a cross-Space move to leave the source Space empty", () => {
    const state = initial();
    const target = terminal(6);
    target.spaceId = "other";
    const withOther = {
      tabs: { ...state.tabs, [target.id]: target },
      spaces: {
        ...state.spaces,
        other: createSpaceWorkbench(4, 5, target.id),
      },
    } satisfies WorkbenchState;

    const moved = moveTabToGroup(withOther, 2, 4);
    expect(moved.spaces.default.groups[1].activeTabId).toBeNull();
    expect(moved.spaces.default.groups[1].tabIds).toEqual([]);
    expect(moved.spaces.other.groups[4].tabIds).toEqual([6, 2]);
    expect(() => assertWorkbenchState(moved)).not.toThrow();
  });

  it("activates the first tab added to an empty Space", () => {
    const state = {
      tabs: {},
      spaces: { default: createEmptySpaceWorkbench(1, 2) },
    } satisfies WorkbenchState;
    const tab = terminal(3);
    const moved = {
      ...state,
      tabs: { [tab.id]: tab },
      spaces: {
        ...state.spaces,
        other: createSpaceWorkbench(4, 5, tab.id),
      },
    } satisfies WorkbenchState;

    const next = moveTabToGroup(moved, tab.id, 1);
    expect(next.spaces.default.groups[1]).toMatchObject({
      tabIds: [tab.id],
      activeTabId: tab.id,
    });
    expect(() => assertWorkbenchState(next)).not.toThrow();
  });

  it("does not reorder a tab dropped into its own group center", () => {
    const state = initial();
    expect(moveTabToGroup(state, 2, 1)).toBe(state);
  });

  it("activates the owning group", () => {
    const second = terminal(4);
    const split = splitWithTab(initial(), second, 1, 4, 5, 6, "right", false);
    const active = activateTab(split, 2);
    expect(active.spaces.default.activeGroupId).toBe(1);
    expect(active.spaces.default.groups[1].activeTabId).toBe(2);
  });

  it("returns only the active group's tabs in visible order", () => {
    const state = initial();
    state.tabs[3] = terminal(3);
    state.spaces.default.groups[1] = {
      id: 1,
      tabIds: [3, 2],
      activeTabId: 2,
    };
    const split = splitWithTab(state, terminal(4), 1, 4, 5, 6, "right", false);

    expect(tabsForActiveGroup(split, "default").map((tab) => tab.id)).toEqual([
      4,
    ]);
    split.spaces.default.activeGroupId = 1;
    expect(tabsForActiveGroup(split, "default").map((tab) => tab.id)).toEqual([
      3, 2,
    ]);
  });

  it("cycles adjacent tabs within the active group", () => {
    const state = initial();
    state.tabs[3] = terminal(3);
    state.tabs[4] = terminal(4);
    state.spaces.default.groups[1] = {
      id: 1,
      tabIds: [3, 2, 4],
      activeTabId: 4,
    };

    expect(adjacentTabId(state, "default", 1)).toBe(3);
    expect(adjacentTabId(state, "default", -1)).toBe(2);
  });

  it("refreshes reusable diff metadata without recreating the tab", () => {
    const current = initial();
    const diff: Tab = {
      id: 2,
      kind: "git-diff",
      spaceId: "default",
      title: "old.ts (W)",
      path: "new.ts",
      repoRoot: "/work",
      side: "worktree",
      originalPath: "old.ts",
      preview: true,
    };
    const state = { ...current, tabs: { 2: diff } };
    const next = patchTab(state, 2, {
      title: "renamed.ts (W)",
      originalPath: "renamed.ts",
      preview: false,
    });
    expect(next.tabs[2]).toMatchObject({
      id: 2,
      title: "renamed.ts (W)",
      originalPath: "renamed.ts",
      preview: false,
    });
  });

  it("refreshes all reusable commit-file metadata", () => {
    const current = initial();
    const diff: Tab = {
      id: 2,
      kind: "git-commit-file",
      spaceId: "default",
      title: "main.ts @ old",
      repoRoot: "/work",
      sha: "full-sha",
      shortSha: "old",
      subject: "old subject",
      path: "main.ts",
      originalPath: null,
      preview: true,
    };
    const state = { ...current, tabs: { 2: diff } };
    const next = patchTab(state, 2, {
      title: "main.ts @ new",
      shortSha: "new",
      subject: "new subject",
      originalPath: "before.ts",
    });
    expect(next.tabs[2]).toMatchObject({
      id: 2,
      title: "main.ts @ new",
      shortSha: "new",
      subject: "new subject",
      originalPath: "before.ts",
    });
  });

  it("reveals a tab with its owning Space, Group, and warm state", () => {
    const current = initial();
    const target = {
      ...terminal(6),
      spaceId: "other",
      cold: true,
    } satisfies Tab;
    const state = {
      tabs: { ...current.tabs, [target.id]: target },
      spaces: {
        ...current.spaces,
        other: createSpaceWorkbench(4, 5, target.id),
      },
    } satisfies WorkbenchState;

    const revealed = revealTabInState(state, target.id);
    expect(revealed?.spaceId).toBe("other");
    expect(revealed?.state.spaces.other.activeGroupId).toBe(4);
    expect(revealed?.state.spaces.other.groups[4].activeTabId).toBe(target.id);
    expect(revealed?.state.tabs[target.id].cold).toBe(false);
  });

  it("pins an existing editor and refreshes its explorer root atomically", () => {
    const current = initial();
    const editor: Tab = {
      id: 2,
      kind: "editor",
      spaceId: "default",
      title: "main.ts",
      path: "/old/main.ts",
      dirty: false,
      preview: true,
      explorerRoot: "/old",
    };
    const state = { ...current, tabs: { 2: editor } };
    const next = patchTab(state, 2, {
      preview: false,
      explorerRoot: "/new",
      copyPathRoot: "/repo",
    });
    expect(next.tabs[2]).toMatchObject({
      preview: false,
      explorerRoot: "/new",
      copyPathRoot: "/repo",
    });
    expect(patchTab(next, 2, { preview: false, explorerRoot: "/new" })).toBe(
      next,
    );
  });

  it("pins a Markdown preview when it becomes dirty", () => {
    const current = initial();
    const markdown: Tab = {
      id: 2,
      kind: "markdown",
      spaceId: "default",
      title: "README.md",
      path: "/work/README.md",
      dirty: false,
      preview: true,
    };
    const state = { ...current, tabs: { 2: markdown } };

    expect(patchTab(state, 2, { dirty: true }).tabs[2]).toMatchObject({
      dirty: true,
      preview: false,
    });
  });

  it("keeps dirty metadata in sync for cold views of the same document", () => {
    const editor = {
      id: 10,
      kind: "editor",
      spaceId: "default",
      title: "README.md",
      path: "C:\\work\\README.md",
      dirty: false,
      preview: true,
    } satisfies Tab;
    const markdown = {
      id: 11,
      kind: "markdown",
      spaceId: "other",
      title: "README.md",
      path: "c:/work/README.md",
      dirty: false,
      preview: false,
      cold: true,
    } satisfies Tab;
    const unrelated = {
      ...editor,
      id: 12,
      path: "C:/work/other.md",
    } satisfies Tab;
    const state = {
      ...initial(),
      tabs: { 10: editor, 11: markdown, 12: unrelated },
    };

    const next = patchDocumentDirty(state, editor.id, true);

    expect(next.tabs[editor.id]).toMatchObject({ dirty: true, preview: false });
    expect(next.tabs[markdown.id]).toMatchObject({ dirty: true, cold: true });
    expect(next.tabs[unrelated.id]).toMatchObject({ dirty: false });
    expect(patchDocumentDirty(next, markdown.id, true)).toBe(next);
  });

  it("reorders by a tab-strip gap", () => {
    const oneGroup = moveTabToGroup(
      splitWithTab(initial(), terminal(4), 1, 5, 6, 7, "right", false),
      4,
      1,
    );
    const withThird = {
      ...oneGroup,
      tabs: { ...oneGroup.tabs, 8: terminal(8) },
      spaces: {
        default: {
          ...oneGroup.spaces.default,
          groups: {
            1: {
              ...oneGroup.spaces.default.groups[1],
              tabIds: [2, 4, 8],
              activeTabId: 8,
            },
          },
        },
      },
    } satisfies WorkbenchState;
    const reordered = reorderTabByGap(withThird, 2, 3);
    expect(reordered.spaces.default.groups[1].tabIds).toEqual([4, 8, 2]);
    expect(() => assertWorkbenchState(reordered)).not.toThrow();
  });

  it("preserves ancestor sizes when a nested split collapses", () => {
    const root: WorkbenchLayoutNode = {
      kind: "split",
      id: 1,
      axis: "row",
      sizes: [40, 60],
      children: [
        { kind: "group", id: 2, groupId: 10 },
        {
          kind: "split",
          id: 3,
          axis: "col",
          sizes: [30, 70],
          children: [
            { kind: "group", id: 4, groupId: 11 },
            { kind: "group", id: 5, groupId: 12 },
          ],
        },
      ],
    };
    const next = removeGroupNode(root, 12);
    expect(next).toMatchObject({
      kind: "split",
      sizes: [40, 60],
      children: [
        { kind: "group", groupId: 10 },
        { kind: "group", groupId: 11 },
      ],
    });
  });

  it("splits a same-axis panel without resetting sibling proportions", () => {
    const root: WorkbenchLayoutNode = {
      kind: "split",
      id: 10,
      axis: "row",
      sizes: [25, 75],
      children: [
        { kind: "group", id: 3, groupId: 1 },
        { kind: "group", id: 5, groupId: 4 },
      ],
    };
    const base = {
      tabs: { 2: terminal(2), 6: terminal(6) },
      spaces: {
        default: {
          root,
          activeGroupId: 1,
          groups: {
            1: { id: 1, tabIds: [2], activeTabId: 2 },
            4: { id: 4, tabIds: [6], activeTabId: 6 },
          },
        },
      },
    } satisfies WorkbenchState;
    const next = splitWithTab(base, terminal(8), 1, 7, 11, 12, "right", false);
    expect(next.spaces.default.root).toMatchObject({
      kind: "split",
      sizes: [12.5, 12.5, 75],
    });
  });

  it("renormalizes retained sizes when a direct child is removed", () => {
    const root: WorkbenchLayoutNode = {
      kind: "split",
      id: 1,
      axis: "row",
      sizes: [20, 30, 50],
      children: [
        { kind: "group", id: 2, groupId: 10 },
        { kind: "group", id: 3, groupId: 11 },
        { kind: "group", id: 4, groupId: 12 },
      ],
    };
    const next = removeGroupNode(root, 11);
    expect(next).toMatchObject({ kind: "split" });
    if (next?.kind !== "split") throw new Error("expected split");
    expect(next.sizes?.[0]).toBeCloseTo(20 / 0.7);
    expect(next.sizes?.[1]).toBeCloseTo(50 / 0.7);
  });

  it("keeps aggregate minimum panel sizes below the available width", () => {
    expect(minimumPanelPercent(4)).toBe(15);
    expect(minimumPanelPercent(8) * 8).toBeLessThanOrEqual(100);
    expect(minimumPanelPercent(20) * 20).toBeLessThanOrEqual(100);
  });
});
