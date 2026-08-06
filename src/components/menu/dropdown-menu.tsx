/**
 * 本文件提供项目级 Dropdown Menu 包装组件。
 * 默认采用紧凑桌面密度，同时允许调用方通过 className 覆盖特殊布局。
 */

import {
  DropdownMenuCheckboxItem as BaseCheckboxItem,
  DropdownMenuContent as BaseContent,
  DropdownMenuItem as BaseItem,
  DropdownMenuRadioItem as BaseRadioItem,
  DropdownMenuSubContent as BaseSubContent,
  DropdownMenuSubTrigger as BaseSubTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_SELECT_ITEM_CLASS,
} from "./styles";

export {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** 渲染默认采用紧凑尺寸的下拉菜单内容层。 */
export function DropdownMenuContent({
  className,
  ...props
}: ComponentProps<typeof BaseContent>) {
  return (
    <BaseContent className={cn(MENU_CONTENT_CLASS, className)} {...props} />
  );
}

/** 渲染默认采用紧凑尺寸的下拉菜单项。 */
export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof BaseItem>) {
  return <BaseItem className={cn(MENU_ITEM_CLASS, className)} {...props} />;
}

/** 渲染为选择指示器预留空间的紧凑复选菜单项。 */
export function DropdownMenuCheckboxItem({
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
export function DropdownMenuRadioItem({
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

/** 渲染默认采用紧凑尺寸的子菜单触发项。 */
export function DropdownMenuSubTrigger({
  className,
  ...props
}: ComponentProps<typeof BaseSubTrigger>) {
  return (
    <BaseSubTrigger className={cn(MENU_ITEM_CLASS, className)} {...props} />
  );
}

/** 渲染默认采用紧凑尺寸的子菜单内容层。 */
export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof BaseSubContent>) {
  return (
    <BaseSubContent className={cn(MENU_CONTENT_CLASS, className)} {...props} />
  );
}
