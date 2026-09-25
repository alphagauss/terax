/**
 * 本文件统一确认对话框的桌面密度与操作按钮。
 * 弹层、焦点管理和确认语义继续由 Radix 与基础组件负责。
 */
import { Button } from "@/components/controls/button";
import {
  AlertDialogContent as BaseContent,
  AlertDialogFooter as BaseFooter,
  AlertDialogHeader as BaseHeader,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { AlertDialog as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

export {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/** 确认对话框不提供拖动标题栏，标题区以分割线与正文区分。 */
export function AlertDialogHeader({
  className,
  ...props
}: ComponentProps<typeof BaseHeader>) {
  return (
    <BaseHeader
      {...props}
      className={cn("gap-1 border-b border-border/60 pb-2", className)}
    />
  );
}

/** 确认与取消在窄桌面窗口中也保持并排，必要时才换行。 */
export function AlertDialogFooter({
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

/** 对话框使用统一表面间距，保留基础组件的宽度规格和焦点恢复。 */
export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof BaseContent>) {
  return (
    <BaseContent
      {...props}
      className={cn(
        "gap-section rounded-lg p-4 pt-3 text-xs duration-surface ease-standard [&_[data-slot=alert-dialog-title]]:text-sm [&_[data-slot=alert-dialog-description]]:text-xs",
        className,
      )}
    />
  );
}

/** 确认操作使用公共按钮，不改变 Radix 的关闭与事件语义。 */
export function AlertDialogAction({
  variant = "default",
  size,
  className,
  ...props
}: ComponentProps<typeof Primitive.Action> &
  Pick<ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <Primitive.Action data-slot="alert-dialog-action" {...props} />
    </Button>
  );
}

/** 取消操作使用公共次级按钮，关闭时仍恢复触发器焦点。 */
export function AlertDialogCancel({
  variant = "outline",
  size,
  className,
  ...props
}: ComponentProps<typeof Primitive.Cancel> &
  Pick<ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <Primitive.Cancel data-slot="alert-dialog-cancel" {...props} />
    </Button>
  );
}
