/**
 * 本文件提供统一的单行输入框，固定桌面字号、尺寸与焦点反馈。
 * 保留原生输入属性，不管理输入值或提交时机。
 */
import { Input as BaseInput } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

type InputProps = ComponentProps<typeof BaseInput> & {
  focusTone?: "neutral" | "accent";
};

/** 渲染 32px 高的输入框；默认中性焦点，强调色规格复用搜索侧边栏的细边框且不显示光晕。 */
export function Input({
  className,
  focusTone = "neutral",
  ...props
}: InputProps) {
  return (
    <BaseInput
      {...props}
      className={cn(
        "h-8 rounded-md px-2.5 py-1 text-xs leading-4 md:text-xs duration-control ease-standard",
        focusTone === "neutral"
          ? "focus-visible:border-foreground/30 focus-visible:ring-0"
          : "border-input bg-background/75 focus-visible:border-ring focus-visible:ring-0",
        className,
      )}
    />
  );
}
