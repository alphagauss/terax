/**
 * 本文件提供连接类设置页的双栏布局和紧凑展示组件。
 * 只统一导航、字段与操作区样式，选择、草稿、保存和运行生命周期仍由各页面管理。
 */

import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";

/** 双栏按详情高度对齐底边；窄窗口中列表排列在详情上方。 */
export function ConnectionSettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 items-stretch gap-5 md:grid-cols-[15rem_minmax(0,1fr)]">
      {children}
    </div>
  );
}

/** 新增入口固定在栏顶；桌面列表脱离固有高度计算，避免长列表撑高双栏。 */
export function ConnectionSettingsList({
  toolbar,
  children,
}: {
  toolbar: ReactNode;
  children: ReactNode;
}) {
  return (
    <aside className="flex min-w-0 flex-col rounded-xl border border-border/60 bg-card/60 md:min-h-0">
      <div className="flex shrink-0 gap-2 border-b border-border/60 p-2.5">
        {toolbar}
      </div>
      <div className="relative min-h-28 flex-1 md:min-h-0">
        <div className="max-h-60 overflow-y-auto p-1.5 md:absolute md:inset-0 md:max-h-none">
          {children}
        </div>
      </div>
    </aside>
  );
}

/** 单一选择用途的列表项，不在导航行中混入连接操作。 */
export function ConnectionSettingsItem({
  selected,
  className,
  ...props
}: ComponentProps<"button"> & { selected: boolean }) {
  return (
    <button
      {...props}
      type="button"
      aria-current={selected ? "true" : undefined}
      className={cn(
        "mb-1 flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors duration-control ease-standard hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-accent",
        className,
      )}
    />
  );
}

/** 详情仅在选择身份变化时淡入，编辑和实时状态更新不会重挂载表单。 */
export function ConnectionSettingsDetail({
  selectionKey,
  children,
  ...props
}: ComponentProps<"section"> & { selectionKey: string }) {
  return (
    <section
      {...props}
      className={cn(
        "min-w-0 rounded-xl border border-border/60 bg-card/60 p-4 text-[12px] [&_input]:h-8 [&_input]:text-[12px] [&_button]:text-[12px]",
        props.className,
      )}
    >
      <div
        key={selectionKey}
        className="terax-tab-in"
        style={{ animationDuration: "var(--dur-pane)" }}
      >
        {children}
      </div>
    </section>
  );
}

/** 使用统一字号和间距展示字段，控件的可访问名称由调用方提供。 */
export function ConnectionSettingsField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <span className="text-[12px] font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

/** 在详情末尾展示保存与实例操作，不决定按钮的业务行为。 */
export function ConnectionSettingsActions({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
      {children}
    </div>
  );
}
