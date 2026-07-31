/**
 * 本文件延迟加载 Alpha 数据管理页。
 * 图表依赖只在用户首次打开数据管理标签后进入运行时。
 */

import { lazy, Suspense } from "react";

const AlphaDataPageInner = lazy(() =>
  import("@/modules/alpha/pages/AlphaDataPage").then((module) => ({
    default: module.AlphaDataPage,
  })),
);

/** 渐进加载 Alpha 数据管理页面。 */
export function AlphaDataPage({ visible }: { visible: boolean }) {
  return (
    <Suspense fallback={null}>
      <AlphaDataPageInner visible={visible} />
    </Suspense>
  );
}
