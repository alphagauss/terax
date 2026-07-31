/**
 * 本文件延迟加载 Alpha 回测页。
 * ECharts 和表格依赖只在用户首次打开回测标签后进入运行时。
 */

import { lazy, Suspense } from "react";

const AlphaBacktestsPageInner = lazy(() =>
  import("@/modules/alpha/pages/AlphaBacktestsPage").then((module) => ({
    default: module.AlphaBacktestsPage,
  })),
);

/** 渐进加载 Alpha 回测页面。 */
export function AlphaBacktestsPage({ visible }: { visible: boolean }) {
  return (
    <Suspense fallback={null}>
      <AlphaBacktestsPageInner visible={visible} />
    </Suspense>
  );
}
