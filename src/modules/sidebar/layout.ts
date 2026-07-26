/**
 * 本文件定义主副侧边栏和工作区的尺寸约束。
 * 所有持久化宽度在进入布局前统一取整并限制最小值。
 */

export const PRIMARY_SIDEBAR_DEFAULT_WIDTH = 260;
export const PRIMARY_SIDEBAR_MIN_WIDTH = 180;

export const SECONDARY_SIDEBAR_DEFAULT_WIDTH = 360;
export const SECONDARY_SIDEBAR_MIN_WIDTH = 280;

export const WORKSPACE_MIN_WIDTH = 320;

export function clampPanelWidth(width: number, minWidth: number): number {
  return Math.max(minWidth, Math.round(width));
}
