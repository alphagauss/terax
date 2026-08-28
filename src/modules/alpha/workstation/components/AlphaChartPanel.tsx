/**
 * 本文件把现有公共行情 Scene 接入 Alpha 工作台面板协议。
 * 面板只消费解析后的标的、配置和可见性，不拥有网格、绑定或持久化状态。
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
  const changeOptions = useCallback(
    (next: typeof options) => onConfigChange(next),
    [onConfigChange],
  );
  return (
    <AlphaServiceBoundary visible={visible}>
      <div className="h-full min-h-0 [&>div]:rounded-none [&>div]:border-0">
        <MarketChartScene
          vtSymbol={vtSymbol}
          visible={visible}
          options={options}
          density="panel"
          onOptionsChange={changeOptions}
        />
      </div>
    </AlphaServiceBoundary>
  );
}
