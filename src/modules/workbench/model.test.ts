import { describe, expect, it } from "vitest";
import {
  activateTab,
  assertWorkbenchState,
  closeTab,
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
} from "./model";
import type { Tab, WorkbenchLayoutNode, WorkbenchState } from "./types";

function terminal(id: number, terminalId = id + 100): Tab {
  return {
    id,
    terminalId,
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
    expect(moved.tabs[2]).toMatchObject({ terminalId: 102 });
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

  it("refuses to remove the last tab from the last group", () => {
    const state = initial();
    expect(closeTab(state, 2)).toBe(state);
  });

  it("refuses a bare cross-Space move that would orphan the source Space", () => {
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

    expect(moveTabToGroup(withOther, 2, 4)).toBe(withOther);
    expect(() => assertWorkbenchState(withOther)).not.toThrow();
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

  it("refreshes reusable diff metadata without recreating the tab", () => {
    const current = initial();
    const diff: Tab = {
      id: 2,
      kind: "git-diff",
      spaceId: "default",
      title: "old.ts (-)",
      path: "new.ts",
      repoRoot: "/work",
      mode: "-",
      originalPath: "old.ts",
    };
    const state = { ...current, tabs: { 2: diff } };
    const next = patchTab(state, 2, {
      title: "renamed.ts (-)",
      originalPath: "renamed.ts",
    });
    expect(next.tabs[2]).toMatchObject({
      id: 2,
      title: "renamed.ts (-)",
      originalPath: "renamed.ts",
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
    });
    expect(next.tabs[2]).toMatchObject({
      preview: false,
      explorerRoot: "/new",
    });
    expect(patchTab(next, 2, { preview: false, explorerRoot: "/new" })).toBe(
      next,
    );
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
