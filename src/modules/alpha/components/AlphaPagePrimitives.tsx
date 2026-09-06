/**
 * 本文件提供 Alpha 业务页面共用的轻量展示组件。
 * 仅统一指标、区块标题和局部状态样式，不包含查询或领域逻辑。
 */

import { Spinner } from "@/components/ui/spinner";
import { SectionHeading } from "@/components/layout/PageHeader";
import type { ReactNode } from "react";

/** 渲染一个 Alpha 摘要指标。 */
export function AlphaMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-3">
      <div className="text-[11px] leading-4 text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold" title={value}>
        {value}
      </div>
    </div>
  );
}

/** 渲染 Alpha 页面区块标题。 */
export function AlphaSectionTitle({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <SectionHeading>{title}</SectionHeading>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
    </div>
  );
}

/** 渲染 Alpha 页面局部加载状态。 */
export function AlphaLoading({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        {label}
      </div>
    </div>
  );
}

/** 渲染 Alpha 页面无数据或局部失败提示。 */
export function AlphaEmptyText({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}
