/**
 * 本文件提供项目级 Select 包装组件。
 * 默认采用 12px 字号和 32px 控件高度，统一焦点反馈，保留调用方的尺寸与样式覆盖。
 */

import {
  SelectItem as BaseItem,
  SelectTrigger as BaseTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectValue,
} from "@/components/ui/select";

/** 默认使用紧凑触发器；size 可选择标准高度，className 和 style 可覆盖样式。 */
export function SelectTrigger({
  className,
  size = "sm",
  ...props
}: ComponentProps<typeof BaseTrigger>) {
  return (
    <BaseTrigger
      size={size}
      className={cn(
        "text-[12px] leading-4 focus-visible:border-transparent focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}

/** 单行菜单项默认采用 12px 字号和紧凑行高，多行内容仍可自然撑开。 */
export function SelectItem({
  className,
  ...props
}: ComponentProps<typeof BaseItem>) {
  return (
    <BaseItem className={cn("text-[12px] leading-4", className)} {...props} />
  );
}
