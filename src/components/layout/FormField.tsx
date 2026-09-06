/**
 * 本文件提供纵向字段的标签、控件和辅助说明布局。
 * 调用方提供控件 id 关联标签，不推导字段类型或管理校验状态。
 */
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/** 以统一间距渲染字段，错误说明由调用方通过 description 提供。 */
export function FormField({
  label,
  htmlFor,
  description,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid min-w-0 gap-1", className)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-xs leading-[18px] font-medium">
          {label}
        </label>
      ) : (
        <span className="text-xs leading-[18px] font-medium">{label}</span>
      )}
      {children}
      {description ? (
        <div className="text-[11px] leading-4 text-muted-foreground">
          {description}
        </div>
      ) : null}
    </div>
  );
}
