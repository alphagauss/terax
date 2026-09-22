/**
 * 本文件提供 Alpha 三栏实验页面的懒加载入口。
 * 三栏和图表实现只在 Workbench 实际挂载三栏实验标签时进入前端模块图。
 */

import { lazy, Suspense } from "react";

const AlphaDeskPageInner = lazy(() =>
  import("@/modules/alpha/pages/AlphaDeskPage").then((module) => ({
    default: module.AlphaDeskPage,
  })),
);

/** 按需挂载 Alpha 三栏实验页面。 */
export function AlphaDeskPage({ visible }: { visible: boolean }) {
  return (
    <Suspense fallback={null}>
      <AlphaDeskPageInner visible={visible} />
    </Suspense>
  );
}
