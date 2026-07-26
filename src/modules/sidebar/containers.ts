/**
 * 本文件集中声明内置侧边栏容器的不可变默认信息。
 * 注册表只描述导航和布局约束，不持有 React 运行时状态。
 */

import {
  AiChat01Icon,
  FolderGitTwoIcon,
  FolderTreeIcon,
} from "@hugeicons/core-free-icons";
import type { SidebarContainerDefinition, SidebarContainerId } from "./types";

export const SIDEBAR_CONTAINERS = [
  {
    id: "explorer",
    titleKey: "files",
    icon: FolderTreeIcon,
    defaultLocation: "primary",
    defaultOrder: 0,
    allowedLocations: ["primary", "secondary"],
    minimumWidth: 180,
  },
  {
    id: "source-control",
    titleKey: "sourceControl",
    icon: FolderGitTwoIcon,
    defaultLocation: "primary",
    defaultOrder: 1,
    allowedLocations: ["primary", "secondary"],
    minimumWidth: 220,
  },
  {
    id: "ai",
    titleKey: "ai",
    icon: AiChat01Icon,
    defaultLocation: "secondary",
    defaultOrder: 0,
    allowedLocations: ["primary", "secondary"],
    minimumWidth: 280,
  },
] as const satisfies readonly SidebarContainerDefinition[];

const CONTAINER_BY_ID = new Map(
  SIDEBAR_CONTAINERS.map((container) => [container.id, container]),
);

/** 返回已注册的侧边栏容器定义。 */
export function getSidebarContainer(
  id: SidebarContainerId,
): SidebarContainerDefinition {
  const container = CONTAINER_BY_ID.get(id);
  if (!container) throw new Error(`Unknown sidebar container: ${id}`);
  return container;
}
