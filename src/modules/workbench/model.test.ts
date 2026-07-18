import { describe, expect, it } from "vitest";
import {
  activateTab,
  assertWorkbenchState,
  closeTab,
  createSpaceWorkbench,
  groupIds,
  moveTabToGroup,
  removeGroupNode,
  reorderTabByGap,
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

  it("moves a tab between groups and collapses an empty source", () => {
    const second = terminal(4);
    const split = splitWithTab(initial(), second, 1, 4, 5, 6, "right", false);
    const moved = moveTabToGroup(split, 2, 4, 1);
    expect(groupIds(moved.spaces.default.root)).toEqual([4]);
    expect(moved.spaces.default.groups[4].tabIds).toEqual([4, 2]);
    expect(moved.tabs[2]).toMatchObject({ terminalId: 102 });
    expect(() => assertWorkbenchState(moved)).not.toThrow();
  });

  it("refuses to remove the last tab from the last group", () => {
    const state = initial();
    expect(closeTab(state, 2)).toBe(state);
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
});
