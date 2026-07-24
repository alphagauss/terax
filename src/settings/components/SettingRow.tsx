/**
 * 本文件提供设置页的通用设置行。
 * 统一标题、说明和控件布局，并复用项目的控制级动效契约以保持各分区交互一致。
 */

import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type Props = {
  title: ReactNode;
  description?: string;
  children: React.ReactNode;
  className?: string;
};

/**
 * 设置项行组件。
 *
 * 它只负责呈现设置项，不持有或持久化偏好状态；悬停与焦点反馈使用控制级时长。
 */
export function SettingRow({ title, description, children, className }: Props) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5 transition-[background-color,border-color,box-shadow] duration-control ease-standard hover:bg-accent/30 focus-within:border-border",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12.5px] font-medium">{title}</span>
        {description ? (
          <span className="text-[10.5px] leading-relaxed text-muted-foreground">
            {description}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}
