/**
 * 本文件提供设置与业务页面共享的标题层级。
 * 只负责标题、说明和操作区的排列，不持有页面状态。
 */
import type { ReactNode } from "react";

/** 展示页面内的分组标题，保持设置与数据页面的标题层级一致。 */
export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[12.5px] leading-[18px] font-medium">{children}</h2>
  );
}

/** 展示页面标题与说明，操作区在空间不足时自然换行。 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-[18px] leading-6 font-semibold tracking-tight">
          {title}
        </h1>
        {description ? (
          <p className="text-xs leading-[18px] text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions}
    </header>
  );
}
