/**
 * 本文件统一业务对话框的间距、文字层级和表面动效。
 * 原有弹层、关闭按钮与键盘交互由基础组件管理，不增加生命周期逻辑。
 */
import {
  DialogContent as BaseContent,
  DialogFooter as BaseFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

export {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** 桌面弹窗操作保持横向排列，空间不足时自然换行。 */
export function DialogFooter({
  className,
  ...props
}: ComponentProps<typeof BaseFooter>) {
  return (
    <BaseFooter
      {...props}
      className={cn("flex-row flex-wrap justify-end", className)}
    />
  );
}

/** 统一对话框内容密度；使用精确 slot 约束内置关闭按钮，不覆盖业务控件。 */
export function DialogContent({
  className,
  showCloseButton = true,
  ...props
}: ComponentProps<typeof BaseContent>) {
  return (
    <BaseContent
      {...props}
      showCloseButton={showCloseButton}
      className={cn(
        "gap-section rounded-lg p-4 text-xs duration-surface ease-standard [&_[data-slot=dialog-header]]:gap-1 [&_[data-slot=dialog-title]]:text-sm [&_[data-slot=dialog-description]]:text-xs [&>[data-slot=dialog-close]]:size-7 [&>[data-slot=dialog-close]]:rounded-md [&>[data-slot=dialog-close]]:duration-control [&>[data-slot=dialog-close]]:focus-visible:border-transparent [&>[data-slot=dialog-close]]:focus-visible:ring-0",
        showCloseButton && "[&_[data-slot=dialog-header]]:pr-8",
        className,
      )}
    />
  );
}
