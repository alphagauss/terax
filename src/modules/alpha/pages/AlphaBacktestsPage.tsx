/** 为独立回测页接入共享查询和服务边界，业务内容由 Scene 复用。 */
import { AlphaServiceBoundary } from "@/modules/alpha/components/AlphaServiceBoundary";
import { AlphaQueryProvider } from "@/modules/alpha/query";
import { BacktestResultsScene } from "@/modules/alpha/scenes/BacktestResultsScene";

export function AlphaBacktestsPage({ visible }: { visible: boolean }) {
  return (
    <AlphaQueryProvider>
      <AlphaServiceBoundary visible={visible}>
        <BacktestResultsScene visible={visible} />
      </AlphaServiceBoundary>
    </AlphaQueryProvider>
  );
}
