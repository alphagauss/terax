/**
 * 本文件提供项目级 Context Menu 包装组件。
 * 默认采用文件管理器的紧凑密度，同时保留特殊菜单的 className 覆盖能力。
 */

import {
  ContextMenuCheckboxItem as BaseCheckboxItem,
  ContextMenuContent as BaseContent,
  ContextMenuItem as BaseItem,
  ContextMenuRadioItem as BaseRadioItem,
  ContextMenuSubContent as BaseSubContent,
  ContextMenuSubTrigger as BaseSubTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_SELECT_ITEM_CLASS,
} from "./styles";

export {
  ContextMenu,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/** 渲染默认采用紧凑尺寸的右键菜单内容层。 */
export function ContextMenuContent({
  className,
  ...props
}: ComponentProps<typeof BaseContent>) {
  return (
    <BaseContent className={cn(MENU_CONTENT_CLASS, className)} {...props} />
  );
}

/** 渲染默认采用紧凑尺寸的右键菜单项。 */
export function ContextMenuItem({
  className,
  ...props
}: ComponentProps<typeof BaseItem>) {
  return <BaseItem className={cn(MENU_ITEM_CLASS, className)} {...props} />;
}

/** 渲染为选择指示器预留空间的紧凑复选菜单项。 */
export function ContextMenuCheckboxItem({
  className,
  ...props
}: ComponentProps<typeof BaseCheckboxItem>) {
  return (
    <BaseCheckboxItem
      className={cn(MENU_SELECT_ITEM_CLASS, className)}
      {...props}
    />
  );
}

/** 渲染为选择指示器预留空间的紧凑单选菜单项。 */
export function ContextMenuRadioItem({
  className,
  ...props
}: ComponentProps<typeof BaseRadioItem>) {
  return (
    <BaseRadioItem
      className={cn(MENU_SELECT_ITEM_CLASS, className)}
      {...props}
    />
  );
}

/** 渲染默认采用紧凑尺寸的右键子菜单触发项。 */
export function ContextMenuSubTrigger({
  className,
  ...props
}: ComponentProps<typeof BaseSubTrigger>) {
  return (
    <BaseSubTrigger className={cn(MENU_ITEM_CLASS, className)} {...props} />
  );
}

/** 渲染默认采用紧凑尺寸的右键子菜单内容层。 */
export function ContextMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof BaseSubContent>) {
  return (
    <BaseSubContent className={cn(MENU_CONTENT_CLASS, className)} {...props} />
  );
}
