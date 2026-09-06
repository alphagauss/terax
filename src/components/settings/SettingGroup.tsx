/**
 * 本文件提供设置分组的标题与共享表面。
 * 子项使用普通 JSX 组合，条件显示、保存和权限不由布局组件管理。
 */
import type { ReactNode } from "react";
import { SectionHeading } from "@/components/layout/PageHeader";

/** 将相关设置放入一个容器，直接子行之间使用细分隔线。 */
export function SettingGroup({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      {title || actions ? (
        <div className="flex min-w-0 items-center justify-between gap-2">
          {title ? <SectionHeading>{title}</SectionHeading> : null}
          {actions}
        </div>
      ) : null}
      <div className="@container rounded-lg border border-border/60 bg-card/60 divide-y divide-border/40 [&>*:first-child]:rounded-t-lg [&>*:last-child]:rounded-b-lg">
        {children}
      </div>
    </section>
  );
}
