/**
 * 本文件维护辅助窗口 label 到业务页面的封闭懒加载注册表。
 * 未注册 label 不会解析为路径或动态导入任意模块。
 */

import type { ComponentType } from "react";

type AuxiliaryPageModule = {
  default: ComponentType;
};

const PAGE_LOADERS: Record<string, () => Promise<AuxiliaryPageModule>> = {
  "auxiliary-settings": async () => {
    const module = await import("@/modules/settings/window/SettingsWindowPage");
    return { default: module.SettingsWindowPage };
  },
};

/** 根据精确窗口 label 懒加载已注册页面。 */
export async function loadAuxiliaryWindowPage(
  label: string,
): Promise<ComponentType> {
  const loader = PAGE_LOADERS[label];
  if (!loader) throw new Error(`未注册的辅助窗口 label: ${label}`);
  return (await loader()).default;
}
