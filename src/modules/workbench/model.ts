/**
 * 本文件实现 Workbench 标签、分组和递归布局的纯状态变换。
 * 仅整个 Space 的唯一分组可以为空，用于承载不属于标签页的基础启动页。
 */

import i18n from "@/i18n";
import { normalizePathForIdentity, titleFromUrl } from "@/lib/utils";
import type {
  SpaceWorkbench,
  Tab,
  TabPatch,
  WorkbenchAxis,
  WorkbenchDirection,
  WorkbenchGroup,
  WorkbenchLayoutNode,
  WorkbenchState,
} from "./types";

export function patchTab(
  state: WorkbenchState,
  id: number,
  patch: TabPatch,
): WorkbenchState {
  const tab = state.tabs[id];
  if (!tab) return state;
  let next: Tab;
  if (tab.kind === "terminal") {
    next = {
      ...tab,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.cwd !== undefined && { cwd: patch.cwd }),
      ...(patch.customTitle !== undefined && {
        customTitle: patch.customTitle || undefined,
      }),
    };
  } else if (tab.kind === "web-preview") {
    next = {
      ...tab,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.url !== undefined && {
        url: patch.url,
        title:
          patch.title ?? titleFromUrl(patch.url, i18n.t("tabs:webPreview")),
      }),
    };
  } else if (tab.kind === "editor" || tab.kind === "markdown") {
    next = {
      ...tab,
      ...(patch.dirty === true && tab.preview && { preview: false }),
      ...(patch.preview !== undefined && { preview: patch.preview }),
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.path !== undefined && { path: patch.path }),
      ...(patch.dirty !== undefined && { dirty: patch.dirty }),
      ...(patch.explorerRoot !== undefined && {
        explorerRoot: patch.explorerRoot,
      }),
      ...(patch.copyPathRoot !== undefined && {
        copyPathRoot: patch.copyPathRoot,
      }),
    };
  } else if (tab.kind === "git-diff") {
    next = {
      ...tab,
      ...(patch.preview !== undefined && { preview: patch.preview }),
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.originalPath !== undefined && {
        originalPath: patch.originalPath,
      }),
    };
  } else if (tab.kind === "git-commit-file") {
    next = {
      ...tab,
      ...(patch.preview !== undefined && { preview: patch.preview }),
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.originalPath !== undefined && {
        originalPath: patch.originalPath,
      }),
      ...(patch.shortSha !== undefined && { shortSha: patch.shortSha }),
      ...(patch.subject !== undefined && { subject: patch.subject }),
    };
  } else {
    if (patch.title === undefined) return state;
    next = { ...tab, title: patch.title };
  }
  const previous = tab as unknown as Record<string, unknown>;
  const updated = next as unknown as Record<string, unknown>;
  const keys = Object.keys(updated);
  if (
    keys.length === Object.keys(previous).length &&
    keys.every((key) => updated[key] === previous[key])
  ) {
    return state;
  }
  return { ...state, tabs: { ...state.tabs, [id]: next } };
}

export function patchDocumentDirty(
  state: WorkbenchState,
  sourceTabId: number,
  dirty: boolean,
  pathIdentity: (path: string) => string = normalizePathForIdentity,
): WorkbenchState {
  const source = state.tabs[sourceTabId];
  if (source?.kind !== "editor" && source?.kind !== "markdown") return state;
  const resourcePath = pathIdentity(source.path);
  let next = state;
  for (const candidate of Object.values(state.tabs)) {
    if (
      (candidate.kind === "editor" || candidate.kind === "markdown") &&
      pathIdentity(candidate.path) === resourcePath
    ) {
      next = patchTab(next, candidate.id, { dirty });
    }
  }
  return next;
}

function directionAxis(direction: WorkbenchDirection): WorkbenchAxis {
  return direction === "left" || direction === "right" ? "row" : "col";
}

function directionBefore(direction: WorkbenchDirection): boolean {
  return direction === "left" || direction === "up";
}

export function groupIds(node: WorkbenchLayoutNode): number[] {
  if (node.kind === "group") return [node.groupId];
  return node.children.flatMap(groupIds);
}

export function findGroupForTab(
  state: WorkbenchState,
  tabId: number,
): { spaceId: string; group: WorkbenchGroup } | null {
  for (const [spaceId, space] of Object.entries(state.spaces)) {
    for (const group of Object.values(space.groups)) {
      if (group.tabIds.includes(tabId)) return { spaceId, group };
    }
  }
  return null;
}

export function tabsForSpace(state: WorkbenchState, spaceId: string): Tab[] {
  const space = state.spaces[spaceId];
  if (!space) return [];
  return groupIds(space.root).flatMap((groupId) =>
    (space.groups[groupId]?.tabIds ?? [])
      .map((id) => state.tabs[id])
      .filter((tab): tab is Tab => tab !== undefined),
  );
}

/** 返回指定 Space 当前分组的标签页，顺序与该分组标签栏一致。 */
export function tabsForActiveGroup(
  state: WorkbenchState,
  spaceId: string,
): Tab[] {
  const space = state.spaces[spaceId];
  if (!space) return [];
  return (space.groups[space.activeGroupId]?.tabIds ?? [])
    .map((id) => state.tabs[id])
    .filter((tab): tab is Tab => tab !== undefined);
}

export function allTabs(state: WorkbenchState): Tab[] {
  return Object.keys(state.spaces).flatMap((spaceId) =>
    tabsForSpace(state, spaceId),
  );
}

export function activeTabId(
  state: WorkbenchState,
  spaceId: string,
): number | null {
  const space = state.spaces[spaceId];
  if (!space) return null;
  return space.groups[space.activeGroupId]?.activeTabId ?? null;
}

/** 按当前分组标签栏顺序返回相邻标签 ID，并在边界循环。 */
export function adjacentTabId(
  state: WorkbenchState,
  spaceId: string,
  delta: 1 | -1,
): number | null {
  const tabs = tabsForActiveGroup(state, spaceId);
  if (tabs.length < 2) return null;
  const currentId = activeTabId(state, spaceId);
  const index = tabs.findIndex((tab) => tab.id === currentId);
  if (index < 0) return null;
  return tabs[(index + delta + tabs.length) % tabs.length]?.id ?? null;
}

export function minimumPanelPercent(childCount: number): number {
  return Math.min(15, 80 / Math.max(1, childCount));
}

function normalizedSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return sizes.map(() => 100 / sizes.length);
  }
  return sizes.map((size) => (size / total) * 100);
}

function sizesForChildren(
  node: Extract<WorkbenchLayoutNode, { kind: "split" }>,
) {
  const sizes = node.sizes;
  if (
    sizes?.length === node.children.length &&
    sizes.every((size) => Number.isFinite(size) && size > 0)
  ) {
    return normalizedSizes(sizes);
  }
  return node.children.map(() => 100 / node.children.length);
}

function insertGroupNode(
  node: WorkbenchLayoutNode,
  targetGroupId: number,
  newGroupId: number,
  newNodeId: number,
  splitId: number,
  direction: WorkbenchDirection,
): WorkbenchLayoutNode {
  const axis = directionAxis(direction);
  const before = directionBefore(direction);
  const groupNode: WorkbenchLayoutNode = {
    kind: "group",
    id: newNodeId,
    groupId: newGroupId,
  };

  if (node.kind === "split" && node.axis === axis) {
    const index = node.children.findIndex(
      (child) => child.kind === "group" && child.groupId === targetGroupId,
    );
    if (index >= 0) {
      const children = [...node.children];
      const sizes = sizesForChildren(node);
      const insertedIndex = before ? index : index + 1;
      const splitSize = sizes[index] / 2;
      sizes[index] = splitSize;
      children.splice(insertedIndex, 0, groupNode);
      sizes.splice(insertedIndex, 0, splitSize);
      return { ...node, children, sizes };
    }
  }

  if (node.kind === "group") {
    if (node.groupId !== targetGroupId) return node;
    return {
      kind: "split",
      id: splitId,
      axis,
      children: before ? [groupNode, node] : [node, groupNode],
      sizes: [50, 50],
    };
  }

  let changed = false;
  const children = node.children.map((child) => {
    const next = insertGroupNode(
      child,
      targetGroupId,
      newGroupId,
      newNodeId,
      splitId,
      direction,
    );
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

export function removeGroupNode(
  node: WorkbenchLayoutNode,
  groupId: number,
): WorkbenchLayoutNode | null {
  return pruneGroupNodes(node, (id) => id === groupId);
}

function pruneGroupNodes(
  node: WorkbenchLayoutNode,
  shouldRemove: (id: number) => boolean,
): WorkbenchLayoutNode | null {
  if (node.kind === "group") return shouldRemove(node.groupId) ? null : node;
  let changed = false;
  const children: WorkbenchLayoutNode[] = [];
  const retainedSizes: number[] = [];
  const sourceSizes = sizesForChildren(node);
  for (const [index, child] of node.children.entries()) {
    const next = pruneGroupNodes(child, shouldRemove);
    if (next !== child) changed = true;
    if (next) {
      children.push(next);
      retainedSizes.push(sourceSizes[index]);
    }
  }
  if (!changed) return node;
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return {
    ...node,
    children,
    sizes:
      children.length === node.children.length
        ? node.sizes
        : normalizedSizes(retainedSizes),
  };
}

export function updateSplitSizes(
  node: WorkbenchLayoutNode,
  splitId: number,
  sizes: number[],
): WorkbenchLayoutNode {
  if (node.kind === "group") return node;
  if (node.id === splitId) {
    return sizes.length === node.children.length ? { ...node, sizes } : node;
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = updateSplitSizes(child, splitId, sizes);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

export function activateTab(
  state: WorkbenchState,
  tabId: number,
): WorkbenchState {
  const owner = findGroupForTab(state, tabId);
  if (!owner) return state;
  const space = state.spaces[owner.spaceId];
  const group = owner.group;
  if (
    space.activeGroupId === group.id &&
    group.activeTabId === tabId &&
    !state.tabs[tabId]?.cold
  ) {
    return state;
  }
  return {
    ...state,
    tabs: state.tabs[tabId]?.cold
      ? { ...state.tabs, [tabId]: { ...state.tabs[tabId], cold: false } }
      : state.tabs,
    spaces: {
      ...state.spaces,
      [owner.spaceId]: {
        ...space,
        activeGroupId: group.id,
        groups: {
          ...space.groups,
          [group.id]: { ...group, activeTabId: tabId },
        },
      },
    },
  };
}

export function revealTabInState(
  state: WorkbenchState,
  tabId: number,
  patch?: TabPatch,
): { state: WorkbenchState; spaceId: string } | null {
  const owner = findGroupForTab(state, tabId);
  if (!owner) return null;
  const patched = patch ? patchTab(state, tabId, patch) : state;
  return { state: activateTab(patched, tabId), spaceId: owner.spaceId };
}

export function activateGroup(
  state: WorkbenchState,
  spaceId: string,
  groupId: number,
): WorkbenchState {
  const space = state.spaces[spaceId];
  const group = space?.groups[groupId];
  if (!space || !group) return state;
  const active =
    group.activeTabId === null ? undefined : state.tabs[group.activeTabId];
  if (space.activeGroupId === groupId && !active?.cold) return state;
  return {
    ...state,
    tabs: active?.cold
      ? { ...state.tabs, [active.id]: { ...active, cold: false } }
      : state.tabs,
    spaces: {
      ...state.spaces,
      [spaceId]: { ...space, activeGroupId: groupId },
    },
  };
}

export function addTabToGroup(
  state: WorkbenchState,
  tab: Tab,
  groupId: number,
  index?: number,
  activate = true,
): WorkbenchState {
  const space = state.spaces[tab.spaceId];
  const group = space?.groups[groupId];
  if (!space || !group) return state;
  const tabIds = [...group.tabIds];
  tabIds.splice(
    index === undefined
      ? tabIds.length
      : Math.max(0, Math.min(index, tabIds.length)),
    0,
    tab.id,
  );
  return {
    ...state,
    tabs: {
      ...state.tabs,
      [tab.id]: activate && tab.cold ? { ...tab, cold: false } : tab,
    },
    spaces: {
      ...state.spaces,
      [tab.spaceId]: {
        ...space,
        activeGroupId: activate ? groupId : space.activeGroupId,
        groups: {
          ...space.groups,
          [groupId]: {
            ...group,
            tabIds,
            activeTabId: activate ? tab.id : (group.activeTabId ?? tab.id),
          },
        },
      },
    },
  };
}

function fallbackTabId(tabIds: number[], removedIndex: number): number {
  return tabIds[Math.max(0, removedIndex - 1)] ?? tabIds[0];
}

function removeTabFromOwner(
  state: WorkbenchState,
  tabId: number,
  keepTab: boolean,
): WorkbenchState {
  const owner = findGroupForTab(state, tabId);
  if (!owner) return state;
  const space = state.spaces[owner.spaceId];
  const group = owner.group;
  const index = group.tabIds.indexOf(tabId);
  const tabIds = group.tabIds.filter((id) => id !== tabId);
  const nextActiveTabId =
    group.activeTabId === tabId
      ? tabIds.length > 0
        ? fallbackTabId(tabIds, index)
        : null
      : group.activeTabId;
  let tabs = keepTab
    ? state.tabs
    : Object.fromEntries(
        Object.entries(state.tabs).filter(([id]) => Number(id) !== tabId),
      );
  const nextActiveTab =
    nextActiveTabId === null ? undefined : tabs[nextActiveTabId];
  if (group.activeTabId === tabId && nextActiveTab?.cold) {
    tabs = {
      ...tabs,
      [nextActiveTab.id]: { ...nextActiveTab, cold: false },
    };
  }

  if (tabIds.length > 0) {
    return {
      ...state,
      tabs,
      spaces: {
        ...state.spaces,
        [owner.spaceId]: {
          ...space,
          groups: {
            ...space.groups,
            [group.id]: {
              ...group,
              tabIds,
              activeTabId: nextActiveTabId,
            },
          },
        },
      },
    };
  }

  const orderedGroups = groupIds(space.root);
  const removedGroupIndex = orderedGroups.indexOf(group.id);
  const remainingGroups = orderedGroups.filter((id) => id !== group.id);
  if (remainingGroups.length === 0) {
    return {
      ...state,
      tabs,
      spaces: {
        ...state.spaces,
        [owner.spaceId]: {
          ...space,
          groups: {
            ...space.groups,
            [group.id]: { ...group, tabIds: [], activeTabId: null },
          },
        },
      },
    };
  }
  const groups = { ...space.groups };
  delete groups[group.id];
  const root = removeGroupNode(space.root, group.id);
  if (!root) return state;
  const activeGroupId =
    space.activeGroupId === group.id
      ? remainingGroups[Math.min(removedGroupIndex, remainingGroups.length - 1)]
      : space.activeGroupId;
  return {
    ...state,
    tabs,
    spaces: {
      ...state.spaces,
      [owner.spaceId]: { root, groups, activeGroupId },
    },
  };
}

export function closeTab(state: WorkbenchState, tabId: number): WorkbenchState {
  return removeTabFromOwner(state, tabId, false);
}

/** 每个受影响的 Space 只更新一次，空 Space 保留原活动分组作为基础页。 */
export function closeTabs(
  state: WorkbenchState,
  ids: readonly number[],
): WorkbenchState {
  if (ids.length === 0) return state;
  if (ids.length === 1) return closeTab(state, ids[0]);

  const closing = new Set(ids.filter((id) => state.tabs[id]));
  if (closing.size === 0) return state;
  const tabs = { ...state.tabs };
  const spaces = { ...state.spaces };
  const affectedSpaces = new Set<string>();
  for (const id of closing) {
    affectedSpaces.add(tabs[id].spaceId);
    delete tabs[id];
  }

  for (const spaceId of affectedSpaces) {
    const space = state.spaces[spaceId];
    const order = groupIds(space.root);
    const groups = { ...space.groups };
    for (const id of order) {
      const group = groups[id];
      const tabIds = group.tabIds.filter((tabId) => !closing.has(tabId));
      if (tabIds.length === group.tabIds.length) continue;
      if (tabIds.length === 0) {
        delete groups[id];
        continue;
      }

      let active = group.activeTabId;
      if (active !== null && closing.has(active)) {
        // 复用单页关闭的选择规则，优先选左侧最近的保留页。
        let index = group.tabIds.indexOf(active) - 1;
        while (index >= 0 && closing.has(group.tabIds[index])) index -= 1;
        active = group.tabIds[index] ?? tabIds[0];
        if (tabs[active].cold) tabs[active] = { ...tabs[active], cold: false };
      }
      groups[id] = { ...group, tabIds, activeTabId: active };
    }

    const previousActive = space.activeGroupId;
    const remaining = order.filter((id) => groups[id]);
    if (remaining.length === 0) {
      groups[previousActive] = {
        id: previousActive,
        tabIds: [],
        activeTabId: null,
      };
    }
    const activeGroupId = groups[previousActive]
      ? previousActive
      : (order
          .slice(order.indexOf(previousActive) + 1)
          .find((id) => groups[id]) ?? remaining[remaining.length - 1]);
    if (activeGroupId !== previousActive) {
      const activeTabId = groups[activeGroupId].activeTabId;
      const active = activeTabId === null ? undefined : tabs[activeTabId];
      if (active?.cold) tabs[active.id] = { ...active, cold: false };
    }
    const root =
      remaining.length === order.length
        ? space.root
        : pruneGroupNodes(space.root, (id) => !groups[id]);
    if (!root) return state;
    spaces[spaceId] = { root, groups, activeGroupId };
  }
  return { tabs, spaces };
}

export function moveTabToGroup(
  state: WorkbenchState,
  tabId: number,
  targetGroupId: number,
  index?: number,
): WorkbenchState {
  const tab = state.tabs[tabId];
  const source = findGroupForTab(state, tabId);
  if (!tab || !source) return state;
  const targetSpaceEntry = Object.entries(state.spaces).find(([, space]) =>
    Boolean(space.groups[targetGroupId]),
  );
  if (!targetSpaceEntry) return state;
  const [targetSpaceId] = targetSpaceEntry;
  if (source.group.id === targetGroupId) {
    if (index === undefined) return state;
    const ids = source.group.tabIds.filter((id) => id !== tabId);
    const targetIndex = Math.max(0, Math.min(index ?? ids.length, ids.length));
    ids.splice(targetIndex, 0, tabId);
    if (ids.every((id, i) => id === source.group.tabIds[i])) return state;
    const space = state.spaces[source.spaceId];
    return {
      ...state,
      spaces: {
        ...state.spaces,
        [source.spaceId]: {
          ...space,
          groups: {
            ...space.groups,
            [source.group.id]: { ...source.group, tabIds: ids },
          },
        },
      },
    };
  }

  let next = removeTabFromOwner(state, tabId, true);
  const moved = { ...tab, spaceId: targetSpaceId } as Tab;
  next = { ...next, tabs: { ...next.tabs, [tabId]: moved } };
  return addTabToGroup(next, moved, targetGroupId, index);
}

export function reorderTabByGap(
  state: WorkbenchState,
  tabId: number,
  gapIndex: number,
): WorkbenchState {
  const owner = findGroupForTab(state, tabId);
  if (!owner) return state;
  const fromIndex = owner.group.tabIds.indexOf(tabId);
  const index = gapIndex > fromIndex ? gapIndex - 1 : gapIndex;
  return moveTabToGroup(state, tabId, owner.group.id, index);
}

export function splitWithTab(
  state: WorkbenchState,
  tab: Tab,
  targetGroupId: number,
  newGroupId: number,
  newNodeId: number,
  splitId: number,
  direction: WorkbenchDirection,
  moveExisting: boolean,
): WorkbenchState {
  const targetEntry = Object.entries(state.spaces).find(([, space]) =>
    Boolean(space.groups[targetGroupId]),
  );
  if (!targetEntry) return state;
  const [spaceId, space] = targetEntry;
  if (
    moveExisting &&
    space.groups[targetGroupId].tabIds.length === 1 &&
    space.groups[targetGroupId].tabIds[0] === tab.id
  ) {
    return state;
  }

  let next = state;
  if (moveExisting) next = removeTabFromOwner(next, tab.id, true);
  const currentSpace = next.spaces[spaceId];
  const moved = {
    ...tab,
    spaceId,
    ...(tab.cold && { cold: false }),
  } as Tab;
  return {
    ...next,
    tabs: { ...next.tabs, [moved.id]: moved },
    spaces: {
      ...next.spaces,
      [spaceId]: {
        root: insertGroupNode(
          currentSpace.root,
          targetGroupId,
          newGroupId,
          newNodeId,
          splitId,
          direction,
        ),
        groups: {
          ...currentSpace.groups,
          [newGroupId]: {
            id: newGroupId,
            tabIds: [moved.id],
            activeTabId: moved.id,
          },
        },
        activeGroupId: newGroupId,
      },
    },
  };
}

export function createSpaceWorkbench(
  groupId: number,
  nodeId: number,
  tabId: number,
): SpaceWorkbench {
  return {
    root: { kind: "group", id: nodeId, groupId },
    groups: {
      [groupId]: { id: groupId, tabIds: [tabId], activeTabId: tabId },
    },
    activeGroupId: groupId,
  };
}

/** 创建一个只包含基础启动页、尚无标签的 Space 布局。 */
export function createEmptySpaceWorkbench(
  groupId: number,
  nodeId: number,
): SpaceWorkbench {
  return {
    root: { kind: "group", id: nodeId, groupId },
    groups: {
      [groupId]: { id: groupId, tabIds: [], activeTabId: null },
    },
    activeGroupId: groupId,
  };
}

export function assertWorkbenchState(state: WorkbenchState): void {
  const owned = new Set<number>();
  for (const [spaceId, space] of Object.entries(state.spaces)) {
    const layoutGroups = groupIds(space.root);
    const recordGroups = Object.keys(space.groups).map(Number);
    if (
      layoutGroups.length !== recordGroups.length ||
      layoutGroups.some((id) => !space.groups[id])
    ) {
      throw new Error(`Space ${spaceId} layout and groups differ`);
    }
    if (!space.groups[space.activeGroupId]) {
      throw new Error(`Space ${spaceId} has no active group`);
    }
    for (const group of Object.values(space.groups)) {
      if (group.tabIds.length === 0) {
        if (layoutGroups.length !== 1 || group.activeTabId !== null) {
          throw new Error(`Group ${group.id} is invalidly empty`);
        }
        continue;
      }
      if (
        group.activeTabId === null ||
        !group.tabIds.includes(group.activeTabId)
      ) {
        throw new Error(`Group ${group.id} has an invalid active tab`);
      }
      for (const tabId of group.tabIds) {
        if (!state.tabs[tabId]) throw new Error(`Tab ${tabId} is missing`);
        if (owned.has(tabId)) throw new Error(`Tab ${tabId} has two owners`);
        if (state.tabs[tabId].spaceId !== spaceId) {
          throw new Error(`Tab ${tabId} has the wrong Space`);
        }
        owned.add(tabId);
      }
    }
  }
  for (const tabId of Object.keys(state.tabs).map(Number)) {
    if (!owned.has(tabId)) throw new Error(`Tab ${tabId} has no owner`);
  }
}
