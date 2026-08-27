/**
 * 本文件把现有公共行情 Scene 接入 Alpha 工作台面板协议。
 * 面板只消费解析后的标的和可见性，不拥有网格、绑定或持久化状态。
 */

import { MarketChartScene } from "@/modules/alpha/chart/scenes/MarketChartScene";
import { AlphaServiceBoundary } from "@/modules/alpha/components/AlphaServiceBoundary";
import type { AlphaPanelProps } from "@/modules/alpha/workstation/model";

/** 在工作台稳定宿主中渲染公共金融图表。 */
export default function AlphaChartPanel({
  vtSymbol,
  visible,
}: AlphaPanelProps) {
  return (
    <AlphaServiceBoundary visible={visible}>
      <div className="h-full min-h-0 [&>div]:rounded-none [&>div]:border-0">
        <MarketChartScene vtSymbol={vtSymbol} visible={visible} />
      </div>
    </AlphaServiceBoundary>
  );
}
