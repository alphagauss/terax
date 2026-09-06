/**
 * 本文件提供统一的单行输入框，固定桌面字号、尺寸与焦点反馈。
 * 保留原生输入属性，不管理输入值或提交时机。
 */
import { Input as BaseInput } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

/** 渲染 32px 高的输入框；宽度和文本对齐由调用方声明。 */
export function Input({
  className,
  ...props
}: ComponentProps<typeof BaseInput>) {
  return (
    <BaseInput
      {...props}
      className={cn(
        "h-8 rounded-md px-2.5 py-1 text-xs leading-4 md:text-xs duration-control ease-standard focus-visible:border-foreground/30 focus-visible:ring-0",
        className,
      )}
    />
  );
}
