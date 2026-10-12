/**
 * 本文件实现辅助窗口统一布局、标题栏和显示时机。
 * 页面可以提供标题栏中间内容，但平台 chrome、拖动区域和窗口按钮由公共层管理。
 */

import { ToastDismissOnClick } from "@/components/ToastDismissOnClick";
import { ErrorHost } from "@/components/errors/ErrorHost";
import { ErrorHistoryButton } from "@/components/errors/ErrorHistoryButton";
import { Toaster } from "@/components/ui/sonner";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useTheme } from "@/modules/theme";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuxiliaryWindowCapabilities } from "./AuxiliaryWindowContext";

type Props = {
  title: string;
  headerContent?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

/** 将浏览器已合成的标题栏底色采样为原生窗口可用的 sRGB 颜色。 */
function readHeaderBackground(header: HTMLElement): [number, number, number] {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context || !header.parentElement) {
    throw new Error("无法读取辅助窗口标题栏颜色");
  }
  canvas.width = 1;
  canvas.height = 1;
  context.fillStyle = getComputedStyle(header.parentElement).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = getComputedStyle(header).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return [red, green, blue];
}

/** 渲染辅助窗口外壳，并在页面首次提交后显示隐藏创建的原生窗口。 */
export function AuxiliaryWindowLayout({
  title,
  headerContent,
  children,
  className,
}: Props) {
  const { t } = useTranslation("common");
  const { mode } = useTheme();
  const { minimizable, maximizable } = useAuxiliaryWindowCapabilities();
  const headerRef = useRef<HTMLElement>(null);
  const modeRef = useRef(mode);
  const scheduleAppearanceRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void getCurrentWindow()
      .setTitle(title)
      .catch((error) => console.error("设置辅助窗口标题失败", error));
  }, [title]);

  useEffect(() => {
    if (!IS_MAC) {
      void invoke("show_auxiliary_window").catch((error) =>
        console.error("显示并聚焦辅助窗口失败", error),
      );
      return;
    }

    let frame: number | null = null;
    let pending = false;
    let syncing = false;
    let shown = false;
    let closed = false;
    let appliedAppearance: string | null = null;
    const sync = async () => {
      if (syncing) return;
      syncing = true;
      while (pending && !closed) {
        pending = false;
        try {
          const header = headerRef.current;
          if (!header) break;
          const background = readHeaderBackground(header);
          const appearance = `${modeRef.current}:${background.join(",")}`;
          if (appearance !== appliedAppearance) {
            await invoke("set_auxiliary_window_appearance", {
              mode: modeRef.current,
              background,
            });
            appliedAppearance = appearance;
          }
        } catch (error) {
          console.error("同步辅助窗口原生标题栏失败", error);
        }
      }
      if (!shown && !closed) {
        shown = true;
        await invoke("show_auxiliary_window").catch((error) =>
          console.error("显示并聚焦辅助窗口失败", error),
        );
      }
      syncing = false;
      // 显示窗口的异步调用期间也可能切换主题，收尾时补发被合并的更新。
      if (pending && !closed) schedule();
    };
    const schedule = () => {
      pending = true;
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        void sync();
      });
    };
    const observer = new MutationObserver(schedule);
    scheduleAppearanceRef.current = schedule;
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    // 隐藏的 WKWebView 可能不调度动画帧，首次显示不能依赖 requestAnimationFrame。
    // 父级主题已在 layout effect 应用，读取计算样式会同步完成所需样式计算。
    pending = true;
    void sync();
    return () => {
      closed = true;
      scheduleAppearanceRef.current = null;
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    modeRef.current = mode;
    scheduleAppearanceRef.current?.();
  }, [mode]);

  return (
    <div
      className={cn(
        "flex h-screen flex-col overflow-hidden bg-background text-foreground select-none",
        className,
      )}
    >
      <header
        ref={headerRef}
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
        <ErrorHistoryButton />
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
      <ErrorHost />
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
