/**
 * 本文件提供 Alpha 工作台页面的懒加载入口。
 * 网格和图表实现只在 Workbench 实际挂载工作台标签时进入前端模块图。
 */

import { lazy, Suspense } from "react";

const AlphaWorkstationPageInner = lazy(() =>
  import("@/modules/alpha/pages/AlphaWorkstationPage").then((module) => ({
    default: module.AlphaWorkstationPage,
  })),
);

/** 按需挂载 Alpha 工作台页面。 */
export function AlphaWorkstationPage({ visible }: { visible: boolean }) {
  return (
    <Suspense fallback={null}>
      <AlphaWorkstationPageInner visible={visible} />
    </Suspense>
  );
}
