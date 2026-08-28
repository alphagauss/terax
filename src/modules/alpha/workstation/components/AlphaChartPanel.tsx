/**
 * 本文件把现有公共行情 Scene 接入 Alpha 工作台面板协议。
 * 面板只拆分解析后的行情选项与指标配置并回传更新，不拥有网格、绑定或持久化状态。
 */

import { MarketChartScene } from "@/modules/alpha/chart/scenes/MarketChartScene";
import { AlphaServiceBoundary } from "@/modules/alpha/components/AlphaServiceBoundary";
import { parseAlphaChartPanelConfig } from "@/modules/alpha/workstation/chartPanelConfig";
import type { AlphaPanelProps } from "@/modules/alpha/workstation/model";
import { useCallback, useMemo } from "react";

/** 在工作台稳定宿主中渲染受控公共金融图表。 */
export default function AlphaChartPanel({
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
  const changeOptions = useCallback(
    (next: typeof marketOptions) =>
      onConfigChange({ ...next, studies: options.studies }),
    [onConfigChange, options.studies],
  );
  const changeStudies = useCallback(
    (studies: typeof options.studies) => {
      const liveIds = new Set(studies.map((study) => study.instanceId));
      const paneRatios = Object.fromEntries(
        Object.entries(options.paneRatios).filter(
          ([key]) => key === "main" || key === "volume" || liveIds.has(key),
        ),
      );
      onConfigChange({ ...marketOptions, paneRatios, studies });
    },
    [marketOptions, onConfigChange, options.paneRatios],
  );
  return (
    <AlphaServiceBoundary visible={visible}>
      <div className="h-full min-h-0 [&>div]:rounded-none [&>div]:border-0">
        <MarketChartScene
          vtSymbol={vtSymbol}
          visible={visible}
          options={marketOptions}
          studies={options.studies}
          density="panel"
          onOptionsChange={changeOptions}
          onStudiesChange={changeStudies}
        />
      </div>
    </AlphaServiceBoundary>
  );
}
