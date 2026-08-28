/**
 * 本文件把现有公共行情 Scene 接入 Alpha 工作台面板协议。
 * 面板只拆分行情选项、实时开关、指标与对比配置，连接可选同步桥并回传更新，不拥有网格、绑定或持久化状态。
 */

import { MarketChartScene } from "@/modules/alpha/chart/scenes/MarketChartScene";
import { useChartSyncPanel } from "@/modules/alpha/chart/sync/ChartSyncContext";
import { AlphaServiceBoundary } from "@/modules/alpha/components/AlphaServiceBoundary";
import { parseAlphaChartPanelConfig } from "@/modules/alpha/workstation/chartPanelConfig";
import type { AlphaPanelProps } from "@/modules/alpha/workstation/model";
import { useCallback, useMemo } from "react";

/** 在工作台稳定宿主中渲染受控公共金融图表。 */
export default function AlphaChartPanel({
  panelId,
  vtSymbol,
  visible,
  config,
  onConfigChange,
}: AlphaPanelProps) {
  const options = useMemo(() => parseAlphaChartPanelConfig(config), [config]);
  const marketOptions = useMemo(
    () => ({
      interval: options.interval,
      adjust: options.adjust,
      chartType: options.chartType,
      showVolume: options.showVolume,
      paneRatios: options.paneRatios,
    }),
    [options],
  );
  const syncCompatibility = useMemo(
    () => ({ interval: options.interval, adjust: options.adjust }),
    [options.adjust, options.interval],
  );
  const syncRuntime = useChartSyncPanel(panelId, syncCompatibility);
  const changeOptions = useCallback(
    (next: typeof marketOptions) =>
      onConfigChange({
        ...next,
        studies: options.studies,
        comparisons: options.comparisons,
        realtime: options.realtime,
      }),
    [onConfigChange, options.comparisons, options.realtime, options.studies],
  );
  const changeStudies = useCallback(
    (studies: typeof options.studies) => {
      const liveIds = new Set(studies.map((study) => study.instanceId));
      const paneRatios = Object.fromEntries(
        Object.entries(options.paneRatios).filter(
          ([key]) => key === "main" || key === "volume" || liveIds.has(key),
        ),
      );
      onConfigChange({
        ...marketOptions,
        paneRatios,
        studies,
        comparisons: options.comparisons,
        realtime: options.realtime,
      });
    },
    [
      marketOptions,
      onConfigChange,
      options.comparisons,
      options.paneRatios,
      options.realtime,
    ],
  );
  const changeComparisons = useCallback(
    (comparisons: typeof options.comparisons) => {
      onConfigChange({
        ...marketOptions,
        studies: options.studies,
        comparisons,
        realtime: options.realtime,
      });
    },
    [marketOptions, onConfigChange, options.realtime, options.studies],
  );
  const changeRealtime = useCallback(
    (realtime: boolean) => {
      onConfigChange({
        ...marketOptions,
        studies: options.studies,
        comparisons: options.comparisons,
        realtime,
      });
    },
    [marketOptions, onConfigChange, options.comparisons, options.studies],
  );
  return (
    <AlphaServiceBoundary visible={visible}>
      <div className="h-full min-h-0 [&>div]:rounded-none [&>div]:border-0">
        <MarketChartScene
          vtSymbol={vtSymbol}
          visible={visible}
          options={marketOptions}
          studies={options.studies}
          comparisons={options.comparisons}
          density="panel"
          syncRuntime={syncRuntime}
          realtimeEnabled={options.realtime}
          onOptionsChange={changeOptions}
          onStudiesChange={changeStudies}
          onComparisonsChange={changeComparisons}
          onRealtimeEnabledChange={changeRealtime}
        />
      </div>
    </AlphaServiceBoundary>
  );
}
