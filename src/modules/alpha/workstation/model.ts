/**
 * 本文件定义 Alpha 工作台的可序列化公共协议。
 * 布局保存面板和固定步长的网格坐标，不设横向列数上限，不承载事件、React、DOM、查询或控制器实例。
 */

export const ALPHA_WORKSTATION_SCHEMA_VERSION = 4;
export const ALPHA_WORKSTATION_STATE_SCHEMA_VERSION = 2;

export type AlphaJsonValue =
  | string
  | number
  | boolean
  | null
  | AlphaJsonValue[]
  | { [key: string]: AlphaJsonValue };

export type AlphaPanelConfig = { [key: string]: AlphaJsonValue };

export type AlphaPanelCategory =
  | "market"
  | "research"
  | "backtest"
  | "trading"
  | "risk"
  | "tools";

export type AlphaSymbolBinding =
  | { mode: "follow" }
  | { mode: "pinned"; vtSymbol: string };

export type AlphaPanelInstance = {
  id: string;
  type: string;
  binding: AlphaSymbolBinding;
  config: AlphaPanelConfig;
  collapsed?: boolean;
};

export type AlphaGridItem = {
  panelId: string;
  x: number;
  y: number;
  w: number;
  /** 始终保存展开高度，折叠占位不写回。 */
  h: number;
};

export type AlphaWorkstationLayout = {
  schemaVersion: typeof ALPHA_WORKSTATION_SCHEMA_VERSION;
  id: string;
  name: string;
  panels: AlphaPanelInstance[];
  /** 数组从底层到顶层排列，独立于面板菜单的稳定顺序。 */
  grid: AlphaGridItem[];
};

export type AlphaChartSyncConfig = {
  groupId: string;
  rangeEnabled: boolean;
  crosshairEnabled: boolean;
};

export const DEFAULT_ALPHA_CHART_SYNC_CONFIG = {
  groupId: "primary",
  rangeEnabled: false,
  crosshairEnabled: false,
} as const satisfies AlphaChartSyncConfig;

export type AlphaWorkstationState = {
  schemaVersion: typeof ALPHA_WORKSTATION_STATE_SCHEMA_VERSION;
  mainSymbol: string;
  locked: boolean;
  chartSync: AlphaChartSyncConfig;
  layout: AlphaWorkstationLayout;
};

export type AlphaPanelSize = {
  w: number;
  h: number;
  minW: number;
  minH: number;
};

export type AlphaPanelProps = {
  panelId: string;
  vtSymbol: string;
  config: AlphaPanelConfig;
  visible: boolean;
  onConfigChange: (config: AlphaPanelConfig) => void;
};

/** 归一化并校验 Alpha 内部的 `代码.交易所` 标的格式。 */
export function normalizeAlphaVtSymbol(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return /^[^.\s]+\.[^.\s]+$/.test(normalized) ? normalized : null;
}
