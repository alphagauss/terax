/**
 * 本文件定义 Alpha 工作台的可序列化公共协议。
 * 布局只保存面板状态和 24 列逻辑坐标，不承载 React、DOM、查询或控制器实例。
 */

export const ALPHA_WORKSTATION_SCHEMA_VERSION = 1;
export const ALPHA_WORKSTATION_GRID_COLUMNS = 24;

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
};

export type AlphaGridItem = {
  panelId: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type AlphaWorkstationLayout = {
  schemaVersion: typeof ALPHA_WORKSTATION_SCHEMA_VERSION;
  id: string;
  name: string;
  panels: AlphaPanelInstance[];
  grid: AlphaGridItem[];
};

export type AlphaPanelSize = {
  w: number;
  h: number;
  minW: number;
  minH: number;
};

export type AlphaPanelProps = {
  panelId: string;
  binding: AlphaSymbolBinding;
  config: AlphaPanelConfig;
  visible: boolean;
};
