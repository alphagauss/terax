/**
 * 本文件将 Alpha 展示偏好连接到公共行情场景。
 * 场景只拆分行情选项、实时开关、指标与对比配置，连接可选同步桥并回传更新，不拥有网格、绑定或持久化状态。
 */

import { MarketChartScene } from "@/modules/alpha/chart/scenes/MarketChartScene";
import type { FinancialChartSyncRuntime } from "@/modules/alpha/chart/sync/model";
import type { AlphaChartPanelConfig } from "@/modules/alpha/chart/chartPanelConfig";
import { useCallback, useMemo } from "react";

/** 渲染带指标、对比与实时设置的公共行情图表。 */
export function ConfiguredMarketChartScene({
  syncRuntime = null,
  vtSymbol,
  visible,
  config,
  onConfigChange,
}: {
  vtSymbol: string;
  visible: boolean;
  config: AlphaChartPanelConfig;
  onConfigChange: (config: AlphaChartPanelConfig) => void;
  syncRuntime?: FinancialChartSyncRuntime | null;
}) {
  const marketOptions = useMemo(
    () => ({
      interval: config.interval,
      adjust: config.adjust,
      chartType: config.chartType,
      showVolume: config.showVolume,
      paneRatios: config.paneRatios,
    }),
    [config],
  );
  const changeOptions = useCallback(
    (next: typeof marketOptions) => onConfigChange({ ...config, ...next }),
    [config, onConfigChange],
  );
  const changeStudies = useCallback(
    (studies: typeof config.studies) => {
      const liveIds = new Set(studies.map((study) => study.instanceId));
      const paneRatios = Object.fromEntries(
        Object.entries(config.paneRatios).filter(
          ([key]) => key === "main" || key === "volume" || liveIds.has(key),
        ),
      );
      onConfigChange({ ...config, paneRatios, studies });
    },
    [config, onConfigChange],
  );
  return (
    <div className="h-full min-h-0 [&>div]:rounded-none [&>div]:border-0">
      <MarketChartScene
        vtSymbol={vtSymbol}
        visible={visible}
        options={marketOptions}
        studies={config.studies}
        comparisons={config.comparisons}
        density="panel"
        syncRuntime={syncRuntime}
        realtimeEnabled={config.realtime}
        onOptionsChange={changeOptions}
        onStudiesChange={changeStudies}
        onComparisonsChange={(comparisons) =>
          onConfigChange({ ...config, comparisons })
        }
        onRealtimeEnabledChange={(realtime) =>
          onConfigChange({ ...config, realtime })
        }
      />
    </div>
  );
}
