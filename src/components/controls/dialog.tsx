/**
 * 本文件统一业务对话框的间距、文字层级和表面动效。
 * 弹层与键盘交互沿用基础组件，关闭按钮复用桌面窗口的视觉反馈。
 */
import {
  DialogContent as BaseContent,
  DialogClose,
  DialogFooter as BaseFooter,
  DialogHeader as BaseHeader,
} from "@/components/ui/dialog";
import { dialogCloseIconButtonClassName } from "@/components/controls/close-button";
import { Hint } from "@/components/controls/tooltip";
import { cn } from "@/lib/utils";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";

export {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** 固定对话框标题与内容共用底色，仅用分割线区分区域。 */
export function DialogHeader({
  className,
  ...props
}: ComponentProps<typeof BaseHeader>) {
  return (
    <BaseHeader
      {...props}
      className={cn("border-b border-border/60 pb-2", className)}
    />
  );
}

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

/** 统一对话框内容密度和关闭按钮样式，关闭行为仍由 Radix 管理。 */
export function DialogContent({
  className,
  showCloseButton = true,
  closeButtonClassName,
  children,
  ...props
}: ComponentProps<typeof BaseContent> & {
  /** 紧凑标题栏可直接调整关闭按钮位置，不依赖组合组件的 data-slot。 */
  closeButtonClassName?: string;
}) {
  const { t } = useTranslation("common");
  return (
    <BaseContent
      {...props}
      showCloseButton={false}
      className={cn(
        "gap-section rounded-lg p-4 pt-3 text-xs duration-surface ease-standard [&_[data-slot=dialog-header]]:gap-1 [&_[data-slot=dialog-title]]:text-sm [&_[data-slot=dialog-description]]:text-xs",
        showCloseButton && "[&_[data-slot=dialog-header]]:pr-8",
        className,
      )}
    >
      {children}
      {showCloseButton && (
        <Hint content={t("close")}>
          <DialogClose
            type="button"
            className={cn(
              dialogCloseIconButtonClassName,
              "absolute top-2 right-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              closeButtonClassName,
            )}
            aria-label={t("close")}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
          </DialogClose>
        </Hint>
      )}
    </BaseContent>
  );
}
