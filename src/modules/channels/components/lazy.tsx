/** 消息通道侧栏按需加载，应用启动不提前加载历史投影和文件选择器。 */
import { lazy, Suspense } from "react";
const Panel = lazy(() =>
  import("@/modules/channels/components/ChannelsPanel").then((module) => ({
    default: module.ChannelsPanel,
  })),
);
export function ChannelsPanel({ visible }: { visible: boolean }) {
  return (
    <Suspense fallback={null}>
      <Panel visible={visible} />
    </Suspense>
  );
}
