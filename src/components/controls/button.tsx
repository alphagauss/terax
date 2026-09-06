/**
 * 本文件提供桌面界面的统一按钮外观与尺寸。
 * 仅包装基础按钮，业务行为和布局宽度由调用方负责。
 */
import { Button as BaseButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

const sizes = {
  default: "h-8 gap-2 px-3",
  sm: "h-7 gap-1.5 px-2",
  xs: "h-6 gap-1 px-1.5",
  lg: "h-9 gap-2 px-4",
  icon: "size-8",
  "icon-sm": "size-7",
  "icon-xs": "size-6",
  "icon-lg": "size-9",
} as const;

/** 默认 32px，工具栏使用 sm，面板标题栏的内嵌操作使用 xs。 */
export function Button({
  className,
  size = "default",
  ...props
}: Omit<ComponentProps<typeof BaseButton>, "size"> & {
  size?: keyof typeof sizes;
}) {
  return (
    <BaseButton
      {...props}
      size={size}
      className={cn(
        "rounded-md text-xs leading-4 duration-control ease-standard focus-visible:border-transparent focus-visible:ring-0 data-[variant=outline]:focus-visible:border-border",
        sizes[size],
        className,
      )}
    />
  );
}
