/**
 * 本文件统一业务对话框的间距、文字层级和表面动效。
 * 弹层与键盘交互沿用基础组件，关闭按钮复用桌面窗口的视觉反馈。
 */
import {
  DialogContent as BaseContent,
  DialogClose,
  DialogFooter as BaseFooter,
} from "@/components/ui/dialog";
import { closeIconButtonClassName } from "@/components/controls/close-button";
import { Hint } from "@/components/controls/tooltip";
import { cn } from "@/lib/utils";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";

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

/** 统一对话框内容密度和关闭按钮样式，关闭行为仍由 Radix 管理。 */
export function DialogContent({
  className,
  showCloseButton = true,
  children,
  ...props
}: ComponentProps<typeof BaseContent>) {
  const { t } = useTranslation("common");
  return (
    <BaseContent
      {...props}
      showCloseButton={false}
      className={cn(
        "gap-section rounded-lg p-4 text-xs duration-surface ease-standard [&_[data-slot=dialog-header]]:gap-1 [&_[data-slot=dialog-title]]:text-sm [&_[data-slot=dialog-description]]:text-xs",
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
              closeIconButtonClassName,
              "absolute top-4 right-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
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
