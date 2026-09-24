/**
 * 本文件实现 Alpha 活动栏对应的侧边栏导航。
 * 侧边栏只打开两套实验布局和数据标签，不持有业务查询或服务状态。
 */

import {
  Database01Icon,
  GridIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslation } from "react-i18next";

type Props = {
  onOpenDesk: () => void;
  onOpenWorkstation: () => void;
  onOpenData: () => void;
};

/**
 * 渲染 Alpha 侧边栏。
 *
 * 点击导航项时在当前工作组打开或复用对应的业务页面。
 */
export function AlphaSidebar({
  onOpenDesk,
  onOpenWorkstation,
  onOpenData,
}: Props) {
  const { t } = useTranslation("alpha");

  return (
    <aside className="flex h-full min-w-0 flex-col bg-sidebar">
      <div className="flex h-8 shrink-0 items-center border-b border-border/60 px-3">
        <span className="truncate text-xs font-medium text-foreground">
          {t("sidebar.title")}
        </span>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-1 p-2">
        <NavItem
          icon={GridIcon}
          label={t("sidebar.desk")}
          onClick={onOpenDesk}
        />
        <NavItem
          icon={GridIcon}
          label={t("sidebar.workstation")}
          onClick={onOpenWorkstation}
        />
        <NavItem
          icon={Database01Icon}
          label={t("sidebar.data")}
          onClick={onOpenData}
        />
      </nav>
    </aside>
  );
}

/** 渲染一个无状态的 Alpha 侧边栏导航项。 */
function NavItem({
  icon,
  label,
  onClick,
}: {
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        // Workbench 打开函数可接收 groupId，不能把 React 点击事件透传过去。
        onClick();
      }}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground outline-none transition-colors duration-control hover:bg-interactive-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
    >
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.8} />
      <span>{label}</span>
    </button>
  );
}
