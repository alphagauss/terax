/**
 * 本文件负责 Workbench 空间布局和可恢复页面的持久化转换。
 * 只保存页面定位信息，运行时状态、连接和临时页面不会写入持久化数据。
 */

import i18n from "@/i18n";
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
import { createEmptySpaceWorkbench } from "@/modules/workbench/model";

export type SerializedTab =
  | {
      kind: "terminal";
      cwd?: string;
      blocks?: boolean;
      customTitle?: string;
    }
  | { kind: "editor"; path: string; explorerRoot?: string }
  | { kind: "web-preview"; url: string }
  | { kind: "markdown"; path: string; explorerRoot?: string }
  | { kind: "alpha-workstation" }
  | { kind: "alpha-data" }
  | { kind: "alpha-backtests" }
  | { kind: "alpha-settings" };

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
    tab.kind === "markdown" ||
    tab.kind === "alpha-workstation" ||
    tab.kind === "alpha-data" ||
    tab.kind === "alpha-backtests" ||
    tab.kind === "alpha-settings"
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
    case "alpha-settings":
      return { kind: "alpha-settings" };
    case "alpha-workstation":
      return { kind: "alpha-workstation" };
    case "alpha-data":
      return { kind: "alpha-data" };
    case "alpha-backtests":
      return { kind: "alpha-backtests" };
    default:
      return null;
  }
}

/** 将指定空间转换为只包含可恢复页面定位信息的持久化布局。 */
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
      return {
        id,
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
        title: titleFromUrl(serialized.url, i18n.t("tabs:webPreview")),
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
        preview: false,
        ...(serialized.explorerRoot !== undefined && {
          explorerRoot: serialized.explorerRoot,
        }),
      } satisfies MarkdownTab;
    case "alpha-settings":
      return {
        id: allocId(),
        kind: "alpha-settings",
        spaceId,
        cold: true,
        title: i18n.t("tabs:alphaSettings"),
      } satisfies Tab;
    case "alpha-workstation":
      return {
        id: allocId(),
        kind: "alpha-workstation",
        spaceId,
        cold: true,
        title: i18n.t("tabs:alphaWorkstation"),
      } satisfies Tab;
    case "alpha-data":
      return {
        id: allocId(),
        kind: "alpha-data",
        spaceId,
        cold: true,
        title: i18n.t("tabs:alphaData"),
      } satisfies Tab;
    case "alpha-backtests":
      return {
        id: allocId(),
        kind: "alpha-backtests",
        spaceId,
        cold: true,
        title: i18n.t("tabs:alphaBacktests"),
      } satisfies Tab;
  }
}

/** 从持久化布局重建页面 ID，并让各页面在挂载后重新加载运行数据。 */
export function hydrateSpaceWorkbench(
  serialized: SerializedWorkbenchNode,
  spaceId: string,
  allocId: () => number,
  options: { allowAlphaPages?: boolean } = {},
): { space: SpaceWorkbench; tabs: Tab[] } | null {
  const groups: SpaceWorkbench["groups"] = {};
  const tabs: Tab[] = [];
  let activeGroupId: number | null = null;

  const visit = (node: SerializedWorkbenchNode): WorkbenchLayoutNode | null => {
    if (node.kind === "group") {
      if (!Array.isArray(node.tabs) || node.tabs.length === 0) return null;
      const acceptedTabs = node.tabs.filter(
        (tab) =>
          !tab.kind.startsWith("alpha-") || options.allowAlphaPages !== false,
      );
      if (acceptedTabs.length === 0) return null;
      const activeSerialized = node.tabs[node.activeTabIndex];
      const hydrated = acceptedTabs.map((tab) =>
        hydrateTab(tab, spaceId, allocId),
      );
      const groupId = allocId();
      const nodeId = allocId();
      const activeIndex = acceptedTabs.indexOf(activeSerialized);
      const activeTab = hydrated[activeIndex] ?? hydrated[0];
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

/** 为没有有效持久化布局的 Space 创建空态，显式 cwd 则创建对应终端。 */
export function freshSpaceWorkbench(
  spaceId: string,
  cwd: string | null | undefined,
  allocId: () => number,
): { space: SpaceWorkbench; tabs: Tab[] } {
  if (!cwd) {
    const groupId = allocId();
    const nodeId = allocId();
    return {
      tabs: [],
      space: createEmptySpaceWorkbench(groupId, nodeId),
    };
  }
  const tabId = allocId();
  const groupId = allocId();
  const nodeId = allocId();
  const tab: TerminalTab = {
    id: tabId,
    kind: "terminal",
    spaceId,
    cold: true,
    title: cwd ? pathBasename(cwd) : "shell",
    cwd,
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

/** 校验未知数据是否为当前版本支持的 Workbench 持久化布局。 */
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
  if (
    tab.kind === "alpha-workstation" ||
    tab.kind === "alpha-data" ||
    tab.kind === "alpha-backtests" ||
    tab.kind === "alpha-settings"
  ) {
    return true;
  }
  if (tab.kind === "editor" || tab.kind === "markdown") {
    return (
      typeof tab.path === "string" &&
      (tab.explorerRoot === undefined || typeof tab.explorerRoot === "string")
    );
  }
  return false;
}
