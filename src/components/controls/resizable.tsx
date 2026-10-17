/** 应用面板分隔条共用布局分割线主题色，拖动与键盘行为由基础组件负责。 */
import { ResizableHandle as BaseHandle } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

export {
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

export function ResizableHandle({
  className,
  ...props
}: ComponentProps<typeof BaseHandle>) {
  return (
    <BaseHandle
      {...props}
      className={cn(
        "bg-layout-divider data-[separator=disabled]:bg-layout-divider dark:data-[separator=disabled]:bg-border/40 [&>div]:bg-layout-divider",
        className,
      )}
    />
  );
}
