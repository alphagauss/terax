import { pathBasename, titleFromUrl } from "@/lib/utils";
import type {
  EditorTab,
  MarkdownTab,
  SpaceWorkbench,
  Tab,
  TerminalTab,
  WebPreviewTab,
  WorkbenchLayoutNode,
  WorkbenchState,
} from "@/modules/workbench";

export type SerializedTab =
  | {
      kind: "terminal";
      cwd?: string;
      blocks?: boolean;
      customTitle?: string;
    }
  | { kind: "editor"; path: string; explorerRoot?: string }
  | { kind: "web-preview"; url: string }
  | { kind: "markdown"; path: string; explorerRoot?: string };

export type SerializedWorkbenchNode =
  | {
      kind: "group";
      tabs: SerializedTab[];
      activeTabIndex: number;
      active?: boolean;
    }
  | {
      kind: "split";
      axis: "row" | "col";
      children: SerializedWorkbenchNode[];
      sizes?: number[];
    };

function isSerializableTab(tab: Tab): boolean {
  return (
    (tab.kind === "terminal" && !tab.private) ||
    tab.kind === "editor" ||
    tab.kind === "web-preview" ||
    tab.kind === "markdown"
  );
}

function normalizedSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return sizes.map(() => 100 / sizes.length);
  }
  return sizes.map((size) => (size / total) * 100);
}

function serializeTab(tab: Tab): SerializedTab | null {
  if (!isSerializableTab(tab)) return null;
  switch (tab.kind) {
    case "terminal":
      return {
        kind: "terminal",
        ...(tab.cwd !== undefined && { cwd: tab.cwd }),
        ...(tab.blocks && { blocks: true }),
        ...(tab.customTitle !== undefined && { customTitle: tab.customTitle }),
      };
    case "editor":
      return {
        kind: "editor",
        path: tab.path,
        ...(tab.explorerRoot !== undefined && {
          explorerRoot: tab.explorerRoot,
        }),
      };
    case "web-preview":
      return { kind: "web-preview", url: tab.url };
    case "markdown":
      return {
        kind: "markdown",
        path: tab.path,
        ...(tab.explorerRoot !== undefined && {
          explorerRoot: tab.explorerRoot,
        }),
      };
    default:
      return null;
  }
}

export function serializeSpaceWorkbench(
  state: WorkbenchState,
  spaceId: string,
): SerializedWorkbenchNode | null {
  const space = state.spaces[spaceId];
  if (!space) return null;

  const visit = (node: WorkbenchLayoutNode): SerializedWorkbenchNode | null => {
    if (node.kind === "group") {
      const group = space.groups[node.groupId];
      if (!group) return null;
      const sourceTabs = group.tabIds
        .map((id) => state.tabs[id])
        .filter((tab): tab is Tab => tab !== undefined);
      const serializable = sourceTabs.filter(isSerializableTab);
      const tabs = serializable
        .map(serializeTab)
        .filter((tab): tab is SerializedTab => tab !== null);
      if (tabs.length === 0) return null;
      const activeIndex = serializable.findIndex(
        (tab) => tab.id === group.activeTabId,
      );
      return {
        kind: "group",
        tabs,
        activeTabIndex: Math.max(0, activeIndex),
        ...(space.activeGroupId === group.id && { active: true }),
      };
    }
    const children: SerializedWorkbenchNode[] = [];
    const retainedSizes: number[] = [];
    const sourceSizes =
      node.sizes?.length === node.children.length &&
      node.sizes.every((size) => Number.isFinite(size) && size > 0)
        ? node.sizes
        : null;
    for (const [index, child] of node.children.entries()) {
      const serialized = visit(child);
      if (!serialized) continue;
      children.push(serialized);
      if (sourceSizes) retainedSizes.push(sourceSizes[index]);
    }
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return {
      kind: "split",
      axis: node.axis,
      children,
      ...(retainedSizes.length === children.length && {
        sizes: normalizedSizes(retainedSizes),
      }),
    };
  };

  return visit(space.root);
}

function hydrateTab(
  serialized: SerializedTab,
  spaceId: string,
  allocId: () => number,
): Tab {
  switch (serialized.kind) {
    case "terminal": {
      const id = allocId();
      const terminalId = allocId();
      return {
        id,
        terminalId,
        kind: "terminal",
        spaceId,
        cold: true,
        title:
          serialized.customTitle ??
          (serialized.cwd
            ? pathBasename(serialized.cwd)
            : serialized.blocks
              ? "blocks"
              : "shell"),
        cwd: serialized.cwd,
        ...(serialized.blocks && { blocks: true }),
        ...(serialized.customTitle !== undefined && {
          customTitle: serialized.customTitle,
        }),
      } satisfies TerminalTab;
    }
    case "editor":
      return {
        id: allocId(),
        kind: "editor",
        spaceId,
        cold: true,
        title: pathBasename(serialized.path),
        path: serialized.path,
        dirty: false,
        preview: false,
        ...(serialized.explorerRoot !== undefined && {
          explorerRoot: serialized.explorerRoot,
        }),
      } satisfies EditorTab;
    case "web-preview":
      return {
        id: allocId(),
        kind: "web-preview",
        spaceId,
        cold: true,
        title: titleFromUrl(serialized.url),
        url: serialized.url,
      } satisfies WebPreviewTab;
    case "markdown":
      return {
        id: allocId(),
        kind: "markdown",
        spaceId,
        cold: true,
        title: pathBasename(serialized.path),
        path: serialized.path,
        dirty: false,
        ...(serialized.explorerRoot !== undefined && {
          explorerRoot: serialized.explorerRoot,
        }),
      } satisfies MarkdownTab;
  }
}

export function hydrateSpaceWorkbench(
  serialized: SerializedWorkbenchNode,
  spaceId: string,
  allocId: () => number,
): { space: SpaceWorkbench; tabs: Tab[] } | null {
  const groups: SpaceWorkbench["groups"] = {};
  const tabs: Tab[] = [];
  let activeGroupId: number | null = null;

  const visit = (node: SerializedWorkbenchNode): WorkbenchLayoutNode | null => {
    if (node.kind === "group") {
      if (!Array.isArray(node.tabs) || node.tabs.length === 0) return null;
      const hydrated = node.tabs.map((tab) =>
        hydrateTab(tab, spaceId, allocId),
      );
      const groupId = allocId();
      const nodeId = allocId();
      const activeTab = hydrated[node.activeTabIndex] ?? hydrated[0];
      groups[groupId] = {
        id: groupId,
        tabIds: hydrated.map((tab) => tab.id),
        activeTabId: activeTab.id,
      };
      tabs.push(...hydrated);
      if (node.active) activeGroupId = groupId;
      return { kind: "group", id: nodeId, groupId };
    }
    if (!Array.isArray(node.children)) return null;
    const children = node.children
      .map(visit)
      .filter((child): child is WorkbenchLayoutNode => child !== null);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return {
      kind: "split",
      id: allocId(),
      axis: node.axis,
      children,
      ...(node.sizes?.length === children.length && { sizes: node.sizes }),
    };
  };

  try {
    const root = visit(serialized);
    if (!root || tabs.length === 0) return null;
    const fallbackGroup = Object.values(groups)[0];
    return {
      tabs,
      space: {
        root,
        groups,
        activeGroupId: activeGroupId ?? fallbackGroup.id,
      },
    };
  } catch {
    return null;
  }
}

export function freshSpaceWorkbench(
  spaceId: string,
  cwd: string | null | undefined,
  allocId: () => number,
): { space: SpaceWorkbench; tabs: Tab[] } {
  const tabId = allocId();
  const terminalId = allocId();
  const groupId = allocId();
  const nodeId = allocId();
  const tab: TerminalTab = {
    id: tabId,
    terminalId,
    kind: "terminal",
    spaceId,
    cold: true,
    title: cwd ? pathBasename(cwd) : "shell",
    cwd: cwd ?? undefined,
  };
  return {
    tabs: [tab],
    space: {
      root: { kind: "group", id: nodeId, groupId },
      groups: {
        [groupId]: { id: groupId, tabIds: [tabId], activeTabId: tabId },
      },
      activeGroupId: groupId,
    },
  };
}

export function isSerializedWorkbenchNode(
  value: unknown,
): value is SerializedWorkbenchNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (node.kind === "group") {
    return (
      Array.isArray(node.tabs) &&
      node.tabs.length > 0 &&
      node.tabs.every(isSerializedTab) &&
      Number.isInteger(node.activeTabIndex) &&
      Number(node.activeTabIndex) >= 0 &&
      (node.active === undefined || typeof node.active === "boolean")
    );
  }
  return (
    node.kind === "split" &&
    (node.axis === "row" || node.axis === "col") &&
    Array.isArray(node.children) &&
    node.children.length > 1 &&
    node.children.every(isSerializedWorkbenchNode) &&
    (node.sizes === undefined ||
      (Array.isArray(node.sizes) &&
        node.sizes.length === node.children.length &&
        node.sizes.every((size) => Number.isFinite(size) && Number(size) > 0)))
  );
}

function isSerializedTab(value: unknown): value is SerializedTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  if (tab.kind === "terminal") {
    return (
      (tab.cwd === undefined || typeof tab.cwd === "string") &&
      (tab.blocks === undefined || typeof tab.blocks === "boolean") &&
      (tab.customTitle === undefined || typeof tab.customTitle === "string")
    );
  }
  if (tab.kind === "web-preview") return typeof tab.url === "string";
  if (tab.kind === "editor" || tab.kind === "markdown") {
    return (
      typeof tab.path === "string" &&
      (tab.explorerRoot === undefined || typeof tab.explorerRoot === "string")
    );
  }
  return false;
}
