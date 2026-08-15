/**
 * 本文件实现辅助窗口统一布局、标题栏和显示时机。
 * 页面可以提供标题栏中间内容，但平台 chrome、拖动区域和窗口按钮由公共层管理。
 */

import { ToastDismissOnClick } from "@/components/ToastDismissOnClick";
import { Toaster } from "@/components/ui/sonner";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuxiliaryWindowCapabilities } from "./AuxiliaryWindowContext";

type Props = {
  title: string;
  headerContent?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

/** 渲染辅助窗口外壳，并在页面首次提交后显示隐藏创建的原生窗口。 */
export function AuxiliaryWindowLayout({
  title,
  headerContent,
  children,
  className,
}: Props) {
  const { t } = useTranslation("common");
  const { minimizable, maximizable } = useAuxiliaryWindowCapabilities();

  useEffect(() => {
    void getCurrentWindow()
      .setTitle(title)
      .catch((error) => console.error("设置辅助窗口标题失败", error));
  }, [title]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void getCurrentWindow()
        .show()
        .catch((error) => console.error("显示辅助窗口失败", error));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      className={cn(
        "flex h-screen flex-col overflow-hidden bg-background text-foreground select-none",
        className,
      )}
    >
      <header
        data-tauri-drag-region
        className={cn(
          "flex h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-card",
          IS_MAC ? "pr-2 pl-20" : "pr-0 pl-2",
        )}
      >
        <div
          data-tauri-drag-region
          className="flex min-w-0 flex-1 items-center"
        >
          {headerContent ?? (
            <span className="truncate text-[12px] font-medium">{title}</span>
          )}
        </div>
        {USE_CUSTOM_WINDOW_CONTROLS && (
          <>
            <span className="ml-1 h-5 w-px shrink-0 bg-border/60" />
            <WindowControls
              minimizable={minimizable}
              maximizable={maximizable}
            />
          </>
        )}
      </header>
      {children}
      <ToastDismissOnClick />
      <Toaster
        position="bottom-right"
        duration={3000}
        closeButton
        toastOptions={{ closeButtonAriaLabel: t("close") }}
      />
    </div>
  );
}
