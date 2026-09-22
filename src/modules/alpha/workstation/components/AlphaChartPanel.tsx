/** 为自由画布图表接入可选同步桥，业务配置由公共场景处理。 */
import { ConfiguredMarketChartScene } from "@/modules/alpha/chart/scenes/ConfiguredMarketChartScene";
import { useChartSyncPanel } from "@/modules/alpha/chart/sync/ChartSyncContext";
import { AlphaServiceBoundary } from "@/modules/alpha/components/AlphaServiceBoundary";
import { parseAlphaChartPanelConfig } from "@/modules/alpha/workstation/chartPanelConfig";
import type { AlphaPanelProps } from "@/modules/alpha/workstation/model";
import { useMemo } from "react";

export default function AlphaChartPanel({
  panelId,
  vtSymbol,
  visible,
  config,
  onConfigChange,
}: AlphaPanelProps) {
  const options = useMemo(() => parseAlphaChartPanelConfig(config), [config]);
  const compatibility = useMemo(
    () => ({ interval: options.interval, adjust: options.adjust }),
    [options.interval, options.adjust],
  );
  const syncRuntime = useChartSyncPanel(panelId, compatibility);
  return (
    <AlphaServiceBoundary visible={visible}>
      <ConfiguredMarketChartScene
        vtSymbol={vtSymbol}
        visible={visible}
        config={options}
        onConfigChange={onConfigChange}
        syncRuntime={syncRuntime}
      />
    </AlphaServiceBoundary>
  );
}
