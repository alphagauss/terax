/** 公共金融图表的时间范围与可选同步接口，不持有布局或 React 状态。 */
import type { MarketTime } from "@/modules/alpha/market/model";

export type ChartTimeRange = {
  from: MarketTime;
  to: MarketTime;
};

export type FinancialChartSyncRuntime = {
  rangeEnabled: boolean;
  crosshairEnabled: boolean;
  publishRange(range: ChartTimeRange): void;
  publishCrosshair(time: MarketTime | null): void;
  subscribe(handlers: {
    onRange(range: ChartTimeRange): void;
    onCrosshair(time: MarketTime | null): void;
  }): () => void;
};
