/**
 * 本文件导出统一侧边栏布局、导航、视图池和可复用区块组件。
 * 业务模块只通过容器 ID 调用布局动作，不直接依赖主副侧边栏实现。
 */

export {
  SidebarActivityBar,
  SecondarySidebarTabs,
  SIDEBAR_COMPOSITE_BAR_HEIGHT,
} from "./SidebarNavigation";
export {
  SidebarViewPool,
  type SidebarPooledView,
} from "./SidebarViewPool";
export { initializeSidebarLayout } from "./persistence";
export { useSidebarLayout } from "./useSidebarLayout";
export {
  SidebarSectionAction,
  SidebarSectionGroup,
  type SidebarSectionDefinition,
  type SidebarSectionRenderState,
} from "./SidebarSectionGroup";
export { SIDEBAR_SECTION_HEADER_HEIGHT } from "./sectionLayout";
export {
  PRIMARY_SIDEBAR_MIN_WIDTH,
  SECONDARY_SIDEBAR_DEFAULT_WIDTH,
  SECONDARY_SIDEBAR_MIN_WIDTH,
  WORKSPACE_MIN_WIDTH,
} from "./layout";
export type {
  ActivityBarPosition,
  ActivityBarSettings,
  ActivityBarSize,
  SidebarContainerDefinition,
  SidebarContainerId,
  SidebarLocation,
  SidebarPlacements,
  SidebarRuntimeState,
  SecondarySidebarMode,
} from "./types";
