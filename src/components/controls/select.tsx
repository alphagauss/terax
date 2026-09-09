/**
 * 本文件提供项目级 Select 包装组件。
 * 默认采用 12px 字号和 32px 控件高度，统一焦点反馈，保留调用方的尺寸与样式覆盖。
 */

import {
  SelectItem as BaseItem,
  SelectTrigger as BaseTrigger,
  SelectContent as BaseContent,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

export {
  Select,
  SelectGroup,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectValue,
} from "@/components/ui/select";

/** 默认 32px，工具栏使用 sm；菜单关闭恢复焦点时不增加边框或光晕。 */
export function SelectTrigger({
  className,
  size = "default",
  ...props
}: Omit<ComponentProps<typeof BaseTrigger>, "title">) {
  return (
    <BaseTrigger
      size={size}
      className={cn(
        "min-w-0 max-w-full rounded-md px-2.5 py-1 text-xs leading-4 data-[size=default]:h-8 data-[size=sm]:h-7 duration-control ease-standard focus-visible:border-transparent focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}

/** 下拉表面沿用基础组件的定位与键盘行为，统一圆角与动效。 */
export function SelectContent({
  className,
  ...props
}: ComponentProps<typeof BaseContent>) {
  return (
    <BaseContent
      {...props}
      className={cn("rounded-lg duration-control ease-standard", className)}
    />
  );
}

/** 单行菜单项默认采用 12px 字号和紧凑行高，多行内容仍可自然撑开。 */
export function SelectItem({
  className,
  ...props
}: ComponentProps<typeof BaseItem>) {
  return (
    <BaseItem
      className={cn("rounded-md text-xs leading-4", className)}
      {...props}
    />
  );
}
