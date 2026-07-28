/**
 * 本文件实现侧边栏布局的纯函数模型。
 * 负责校验持久化输入、移动容器并维持每个容器只属于一个位置的不变量。
 */

import {
  PRIMARY_SIDEBAR_DEFAULT_WIDTH,
  PRIMARY_SIDEBAR_MIN_WIDTH,
  SECONDARY_SIDEBAR_DEFAULT_WIDTH,
  SECONDARY_SIDEBAR_MIN_WIDTH,
  clampPanelWidth,
} from "./layout";
import { SIDEBAR_CONTAINERS, getSidebarContainer } from "./containers";
import type {
  ActivityBarPosition,
  ActivityBarSize,
  SidebarContainerId,
  SidebarLocation,
  SidebarPlacementState,
  SidebarPlacements,
  SidebarRuntimeState,
} from "./types";

export const SIDEBAR_LOCATIONS = ["primary", "secondary"] as const;

export const DEFAULT_SIDEBAR_PLACEMENT_STATE: SidebarPlacementState = {
  version: 1,
  placements: {
    primary: ["explorer", "source-control", "alpha"],
    secondary: ["ai"],
  },
  activityBar: {
    position: "default",
    size: "default",
    hiddenContainerIds: [],
  },
};

export const DEFAULT_SIDEBAR_RUNTIME_STATE: SidebarRuntimeState = {
  version: 1,
  primary: {
    activeId: "explorer",
    collapsed: false,
    width: PRIMARY_SIDEBAR_DEFAULT_WIDTH,
  },
  secondary: {
    activeId: "ai",
    collapsed: true,
    width: SECONDARY_SIDEBAR_DEFAULT_WIDTH,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContainerId(value: unknown): value is SidebarContainerId {
  return SIDEBAR_CONTAINERS.some((container) => container.id === value);
}

function isActivityBarPosition(value: unknown): value is ActivityBarPosition {
  return (
    value === "default" ||
    value === "top" ||
    value === "bottom" ||
    value === "hidden"
  );
}

function isActivityBarSize(value: unknown): value is ActivityBarSize {
  return value === "default" || value === "compact";
}

function sameContainerIds(
  left: readonly SidebarContainerId[],
  right: readonly SidebarContainerId[],
): boolean {
  return (
    left.length === right.length &&
    left.every((candidate, index) => candidate === right[index])
  );
}

function validIdsAtLocation(
  value: unknown,
  location: SidebarLocation,
  claimed: Set<SidebarContainerId>,
): SidebarContainerId[] {
  if (!Array.isArray(value)) return [];
  const result: SidebarContainerId[] = [];
  for (const candidate of value) {
    if (!isContainerId(candidate) || claimed.has(candidate)) continue;
    if (!getSidebarContainer(candidate).allowedLocations.includes(location)) {
      continue;
    }
    claimed.add(candidate);
    result.push(candidate);
  }
  return result;
}

/** 将未知或损坏的全局布局归一化为完整、无重复的容器位置。 */
export function normalizeSidebarPlacementState(
  value: unknown,
): SidebarPlacementState {
  const placementsValue =
    isRecord(value) && value.version === 1 && isRecord(value.placements)
      ? value.placements
      : {};
  const claimed = new Set<SidebarContainerId>();
  const placements: SidebarPlacements = {
    primary: validIdsAtLocation(placementsValue.primary, "primary", claimed),
    secondary: validIdsAtLocation(
      placementsValue.secondary,
      "secondary",
      claimed,
    ),
  };

  for (const container of [...SIDEBAR_CONTAINERS].sort(
    (left, right) => left.defaultOrder - right.defaultOrder,
  )) {
    if (!claimed.has(container.id)) {
      placements[container.defaultLocation].push(container.id);
    }
  }

  const activityValue =
    isRecord(value) && value.version === 1 && isRecord(value.activityBar)
      ? value.activityBar
      : {};
  const hiddenContainerIds = Array.isArray(activityValue.hiddenContainerIds)
    ? [...new Set(activityValue.hiddenContainerIds.filter(isContainerId))]
    : [];

  return {
    version: 1,
    placements,
    activityBar: {
      position: isActivityBarPosition(activityValue.position)
        ? activityValue.position
        : "default",
      size: isActivityBarSize(activityValue.size)
        ? activityValue.size
        : "default",
      hiddenContainerIds,
    },
  };
}

function readRuntimeLocation(
  value: unknown,
  location: SidebarLocation,
  placements: SidebarPlacements,
  hiddenContainerIds: ReadonlySet<SidebarContainerId>,
) {
  const fallback = DEFAULT_SIDEBAR_RUNTIME_STATE[location];
  const record = isRecord(value) ? value : {};
  const activeId =
    isContainerId(record.activeId) &&
    placements[location].includes(record.activeId) &&
    !hiddenContainerIds.has(record.activeId)
      ? record.activeId
      : (placements[location].find((id) => !hiddenContainerIds.has(id)) ??
        null);
  const minWidth =
    location === "primary"
      ? PRIMARY_SIDEBAR_MIN_WIDTH
      : SECONDARY_SIDEBAR_MIN_WIDTH;
  return {
    activeId,
    collapsed:
      typeof record.collapsed === "boolean"
        ? record.collapsed || activeId === null
        : fallback.collapsed || activeId === null,
    width: clampPanelWidth(
      typeof record.width === "number" ? record.width : fallback.width,
      minWidth,
    ),
  };
}

/** 将窗口运行状态约束到当前容器布局，并修复无效激活项和尺寸。 */
export function normalizeSidebarRuntimeState(
  value: unknown,
  placements: SidebarPlacements,
  hiddenContainerIds: readonly SidebarContainerId[] = [],
): SidebarRuntimeState {
  const record = isRecord(value) && value.version === 1 ? value : {};
  const hidden = new Set(hiddenContainerIds);
  return {
    version: 1,
    primary: readRuntimeLocation(record.primary, "primary", placements, hidden),
    secondary: readRuntimeLocation(
      record.secondary,
      "secondary",
      placements,
      hidden,
    ),
  };
}

/** 查找容器当前所属的位置。 */
export function findSidebarContainerLocation(
  placements: SidebarPlacements,
  id: SidebarContainerId,
): SidebarLocation {
  return placements.primary.includes(id) ? "primary" : "secondary";
}

/** 计算容器移动后的窗口状态，同栏排序保持当前活动项和折叠状态。 */
export function runtimeAfterSidebarContainerMove(
  runtime: SidebarRuntimeState,
  previousPlacements: SidebarPlacements,
  nextPlacements: SidebarPlacements,
  id: SidebarContainerId,
  targetLocation: SidebarLocation,
  hiddenContainerIds: readonly SidebarContainerId[] = [],
): SidebarRuntimeState {
  const sourceLocation = findSidebarContainerLocation(previousPlacements, id);
  if (sourceLocation === targetLocation) return runtime;

  const hidden = new Set(hiddenContainerIds);
  const next: SidebarRuntimeState = {
    ...runtime,
    primary: { ...runtime.primary },
    secondary: { ...runtime.secondary },
  };
  if (next[sourceLocation].activeId === id) {
    const fallback =
      nextPlacements[sourceLocation].find((candidate) => {
        return !hidden.has(candidate);
      }) ?? null;
    next[sourceLocation].activeId = fallback;
    if (fallback === null) next[sourceLocation].collapsed = true;
  }
  next[targetLocation].activeId = id;
  next[targetLocation].collapsed = false;
  return next;
}

/** 原子移动或重排一个容器，目标索引表示删除源容器后的插入间隙。 */
export function moveSidebarContainer(
  placements: SidebarPlacements,
  id: SidebarContainerId,
  targetLocation: SidebarLocation,
  targetIndex: number,
): SidebarPlacements {
  const definition = getSidebarContainer(id);
  if (!definition.allowedLocations.includes(targetLocation)) return placements;

  const next: SidebarPlacements = {
    primary: placements.primary.filter((candidate) => candidate !== id),
    secondary: placements.secondary.filter((candidate) => candidate !== id),
  };
  const target = next[targetLocation];
  const index = Math.max(0, Math.min(Math.round(targetIndex), target.length));
  target.splice(index, 0, id);
  if (
    sameContainerIds(next.primary, placements.primary) &&
    sameContainerIds(next.secondary, placements.secondary)
  ) {
    return placements;
  }
  return next;
}
