/** 固定网格步长，画布按视口和内容扩展；两行恰好容纳折叠标题栏。 */
import type { AlphaGridItem } from "@/modules/alpha/workstation/model";

export const ALPHA_GRID_COLUMN_STEP = 15;
export const ALPHA_GRID_ROW_HEIGHT = 14;
export const ALPHA_GRID_GAP = 1;
export const ALPHA_GRID_PADDING = 1;
export const ALPHA_PANEL_COLLAPSED_ROWS = 2;
export const ALPHA_PANEL_HEADER_HEIGHT =
  ALPHA_PANEL_COLLAPSED_ROWS * (ALPHA_GRID_ROW_HEIGHT + ALPHA_GRID_GAP) -
  ALPHA_GRID_GAP;

/** 网格按完整列计算，画布补齐视口余数，避免空白末列制造横向滚动条。 */
export function alphaCanvasGeometry(
  viewportWidth: number,
  grid: readonly AlphaGridItem[],
  reservedColumns = 0,
) {
  const viewportColumns = Math.floor(
    (viewportWidth + ALPHA_GRID_GAP - 2 * ALPHA_GRID_PADDING) /
      ALPHA_GRID_COLUMN_STEP,
  );
  const columns = grid.reduce(
    (right, item) => Math.max(right, item.x + item.w),
    Math.max(1, viewportColumns, reservedColumns),
  );
  const gridWidth =
    columns * ALPHA_GRID_COLUMN_STEP - ALPHA_GRID_GAP + 2 * ALPHA_GRID_PADDING;
  return { columns, gridWidth, width: Math.max(viewportWidth, gridWidth) };
}

/** 网格跨度包含内部行间距，内容高度扣除标题栏。 */
export function alphaPanelBodyHeight(rows: number): number {
  return Math.max(
    0,
    rows * (ALPHA_GRID_ROW_HEIGHT + ALPHA_GRID_GAP) -
      ALPHA_GRID_GAP -
      ALPHA_PANEL_HEADER_HEIGHT,
  );
}
