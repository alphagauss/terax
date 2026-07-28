/**
 * 本文件实现 Alpha 活动栏对应的侧边栏入口。
 * 侧边栏只负责导航，服务配置和状态管理由 Workbench 设置页持有。
 */

import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslation } from "react-i18next";

type Props = {
  onOpenSettings: () => void;
};

/**
 * 渲染 Alpha 侧边栏。
 *
 * 当前仅提供设置入口，点击活动栏本身不会自动打开 Workbench 页面。
 */
export function AlphaSidebar({ onOpenSettings }: Props) {
  const { t } = useTranslation("alpha");

  return (
    <aside className="flex h-full min-w-0 flex-col bg-sidebar">
      <div className="flex h-8 shrink-0 items-center border-b border-border/60 px-3">
        <span className="truncate text-xs font-medium text-foreground">
          {t("sidebar.title")}
        </span>
      </div>
      <div className="min-h-0 flex-1" />
      <div className="border-t border-border/60 p-2">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground outline-none transition-colors duration-control hover:bg-foreground/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
        >
          <HugeiconsIcon icon={Settings01Icon} size={15} strokeWidth={1.8} />
          <span>{t("sidebar.settings")}</span>
        </button>
      </div>
    </aside>
  );
}
