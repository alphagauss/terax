/**
 * 本文件提供设置分组内部的说明与控件行。
 * 行不绘制独立卡片，窄容器下纵向排列；设置状态仍归调用方所有。
 */
import type { ReactNode } from "react";

/** 展示一个设置项；说明可换行，控件在窄容器中使用独立的一行。 */
export function SettingRow({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 px-3 py-2 @min-[30rem]:flex-row @min-[30rem]:items-center @min-[30rem]:justify-between @min-[30rem]:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12.5px] leading-[18px] font-medium">
          {title}
        </span>
        {description ? (
          <span className="text-[11px] leading-4 text-muted-foreground break-words">
            {description}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 max-w-full items-center @min-[30rem]:max-w-[55%] @min-[30rem]:shrink-0 [&>*]:max-w-full">
        {children}
      </div>
    </div>
  );
}
