export const PRIMARY_SIDEBAR_DEFAULT_WIDTH = 260;
export const PRIMARY_SIDEBAR_MIN_WIDTH = 180;

export const SECONDARY_SIDEBAR_DEFAULT_WIDTH = 360;
export const SECONDARY_SIDEBAR_MIN_WIDTH = 280;

export const WORKSPACE_MIN_WIDTH = 320;

export function clampPanelWidth(width: number, minWidth: number): number {
  return Math.max(minWidth, Math.round(width));
}
