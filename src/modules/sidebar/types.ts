/**
 * 本文件定义侧边栏容器、位置和持久化状态的公共类型。
 * 容器默认信息保持不可变，用户布局与窗口运行状态分别存储。
 */

import type { HugeiconsIcon } from "@hugeicons/react";
import type { Tab } from "@/modules/workbench/types";

export type SidebarLocation = "primary" | "secondary";

export type SecondarySidebarMode = "normal" | "expanded" | "maximized";

export type SidebarContainerId =
  | "explorer"
  | "search"
  | "source-control"
  | "alpha"
  | "ai"
  | "channels";

export type ActivityBarPosition = "default" | "top" | "bottom" | "hidden";

export type ActivityBarSize = "default" | "compact";

export type ActivityBarSettings = {
  position: ActivityBarPosition;
  size: ActivityBarSize;
  hiddenContainerIds: SidebarContainerId[];
};

export type SidebarContainerDefinition = {
  id: SidebarContainerId;
  titleKey: "files" | "search" | "sourceControl" | "alpha" | "ai" | "channels";
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  defaultLocation: SidebarLocation;
  defaultOrder: number;
  allowedLocations: readonly SidebarLocation[];
  minimumWidth: number;
  /** 应用入口对应的工作页类型，用于导航高亮；此类入口不参与侧边栏内容激活。 */
  opensPage?: Tab["kind"];
};

export type SidebarPlacements = Record<SidebarLocation, SidebarContainerId[]>;

export type SidebarLocationRuntime = {
  activeId: SidebarContainerId | null;
  collapsed: boolean;
  width: number;
};

export type SidebarRuntimeState = {
  version: 1;
  primary: SidebarLocationRuntime;
  secondary: SidebarLocationRuntime;
  secondaryMode: SecondarySidebarMode;
};

export type SidebarPlacementState = {
  version: 1;
  placements: SidebarPlacements;
  activityBar: ActivityBarSettings;
};
