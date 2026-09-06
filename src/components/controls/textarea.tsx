/**
 * 本文件提供统一的多行输入外观。
 * 内容、最小高度与是否允许调整大小由所属表单负责。
 */
import { Textarea as BaseTextarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

/** 渲染统一字号、内边距和键盘焦点的多行输入框。 */
export function Textarea({
  className,
  ...props
}: ComponentProps<typeof BaseTextarea>) {
  return (
    <BaseTextarea
      {...props}
      className={cn(
        "rounded-md px-2.5 py-2 text-xs leading-[18px] md:text-xs duration-control ease-standard focus-visible:border-foreground/30 focus-visible:ring-0",
        className,
      )}
    />
  );
}
