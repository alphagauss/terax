/**
 * 本文件定义 Workbench 模块的公开导出边界。
 * 调用方通过此入口访问状态模型、视图与纯导航查询。
 */

export {
  activeTabId,
  findGroupForTab,
  tabsForActiveGroup,
  tabsForSpace,
} from "@/modules/workbench/model";
export {
  type AiDiffStatus,
  type AiDiffTab,
  DEFAULT_SPACE_ID,
  type EditorTab,
  type GitCommitFileDiffTab,
  type GitDiffTab,
  type MarkdownTab,
  type SpaceWorkbench,
  type Tab,
  type TerminalTab,
  type WebPreviewTab,
  type WorkbenchLayoutNode,
  type WorkbenchState,
} from "@/modules/workbench/types";
export { useStartupWarmup } from "@/modules/workbench/useStartupWarmup";
export { useWorkbench } from "@/modules/workbench/useWorkbench";
export type { WorkbenchViewServices } from "@/modules/workbench/viewRegistry";
export type { WorkbenchChromeActions } from "@/modules/workbench/WorkbenchGrid";
export {
  useWorkbenchOverlayContainer,
  useWorkbenchPageActivity,
  WorkbenchPageDialog,
  type WorkbenchPageDialogProps,
  type WorkbenchPageOverlayProps,
  WorkbenchPageWindow,
} from "@/modules/workbench/WorkbenchPageOverlays";
export { WorkbenchSurface } from "@/modules/workbench/WorkbenchSurface";
