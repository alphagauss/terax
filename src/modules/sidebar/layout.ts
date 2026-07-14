export const PRIMARY_SIDEBAR_DEFAULT_WIDTH = 260;
export const PRIMARY_SIDEBAR_MIN_WIDTH = 180;
export const PRIMARY_SIDEBAR_MAX_WIDTH = 480;

export const SECONDARY_SIDEBAR_DEFAULT_WIDTH = 360;
export const SECONDARY_SIDEBAR_MIN_WIDTH = 280;
export const SECONDARY_SIDEBAR_MAX_WIDTH = 600;

export const WORKSPACE_MIN_WIDTH = 320;

export function clampPanelWidth(
  width: number,
  minWidth: number,
  maxWidth: number,
): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}
