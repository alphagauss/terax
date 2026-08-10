/**
 * 本文件提供项目级 Select 包装组件。
 * 统一选择控件的焦点反馈，同时保留 registry 组件的结构、动效和覆盖能力。
 */

import { SelectTrigger as BaseTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectValue,
} from "@/components/ui/select";

/** 渲染不带高亮边框和光晕的统一选择器触发控件。 */
export function SelectTrigger({
  className,
  ...props
}: ComponentProps<typeof BaseTrigger>) {
  return (
    <BaseTrigger
      className={cn(
        "focus-visible:border-transparent focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}
