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

/** 半透明反馈叠加所在面板底色，避免固定底色在相近背景上失去悬停层次。 */
const ghostBackground =
  "hover:bg-interactive-hover aria-expanded:bg-interactive-hover dark:hover:bg-interactive-hover";

/** 次要操作共用 ghost 的背景与打开反馈，语义变体只改变文字及继承它的图标颜色。 */
const ghostColors = {
  ghost:
    "text-muted-foreground hover:text-foreground aria-expanded:text-foreground",
  "ghost-warning":
    "text-amber-600 hover:text-amber-700 aria-expanded:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300 dark:aria-expanded:text-amber-400",
  "ghost-destructive":
    "text-destructive hover:text-destructive aria-expanded:text-destructive",
  "ghost-destructive-hover":
    "text-muted-foreground hover:text-destructive aria-expanded:text-destructive",
} as const;

type ButtonVariant =
  | ComponentProps<typeof BaseButton>["variant"]
  | keyof typeof ghostColors;
export type ButtonProps = Omit<
  ComponentProps<typeof BaseButton>,
  "size" | "title" | "variant"
> & {
  size?: keyof typeof sizes;
  variant?: ButtonVariant;
};

/** 默认 32px，工具栏使用 sm，面板标题栏的内嵌操作使用 xs。 */
export function Button({
  className,
  size = "default",
  variant = "default",
  ...props
}: ButtonProps) {
  const baseVariant =
    variant === "ghost-warning" ||
    variant === "ghost-destructive" ||
    variant === "ghost-destructive-hover"
      ? "ghost"
      : variant;
  const color =
    variant && variant in ghostColors
      ? ghostColors[variant as keyof typeof ghostColors]
      : undefined;
  return (
    <BaseButton
      {...props}
      variant={baseVariant}
      data-variant={variant}
      size={size}
      className={cn(
        "rounded-md text-xs leading-4 duration-control ease-standard focus-visible:border-transparent focus-visible:ring-0 data-[variant=outline]:focus-visible:border-border",
        sizes[size],
        baseVariant === "ghost" && ghostBackground,
        color,
        className,
      )}
    />
  );
}
