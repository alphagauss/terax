/**
 * 本文件延迟加载 Alpha 设置页。
 * Alpha 查询运行时只在用户首次打开 Alpha 页面后进入前端运行时。
 */

import { lazy, Suspense } from "react";

const AlphaSettingsPageInner = lazy(() =>
  import("@/modules/alpha/pages/AlphaSettingsPage").then((module) => ({
    default: module.AlphaSettingsPage,
  })),
);

/** 渐进加载 Alpha 设置页面。 */
export function AlphaSettingsPage({ visible }: { visible: boolean }) {
  return (
    <Suspense fallback={null}>
      <AlphaSettingsPageInner visible={visible} />
    </Suspense>
  );
}
