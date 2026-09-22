/** 面板标题栏与网格共用的像素规格；一行恰好容纳折叠标题栏。 */
export const ALPHA_PANEL_HEADER_HEIGHT = 34;
export const ALPHA_GRID_ROW_HEIGHT = ALPHA_PANEL_HEADER_HEIGHT;
export const ALPHA_GRID_GAP = 2;

/** 网格跨度包含内部行间距，内容高度扣除标题栏。 */
export function alphaPanelBodyHeight(rows: number): number {
  return (
    rows * (ALPHA_GRID_ROW_HEIGHT + ALPHA_GRID_GAP) -
    ALPHA_GRID_GAP -
    ALPHA_PANEL_HEADER_HEIGHT
  );
}
