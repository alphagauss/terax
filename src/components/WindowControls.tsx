/**
 * 本文件渲染 Windows 和 Linux 的统一窗口控制按钮。
 * 同步最大化与全屏状态，并确保指针焦点不会跨窗口形态残留。
 */

import { Hint } from "@/components/controls/tooltip";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Copy01Icon,
  MinusSignIcon,
  SquareIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  minimizable?: boolean;
  maximizable?: boolean;
};

/**
 * 渲染与当前原生窗口能力一致的最小化、还原和关闭按钮。
 *
 * 全屏时还原按钮退出全屏；并发 resize 查询只提交最后一次结果。
 */
export function WindowControls({
  minimizable = true,
  maximizable = true,
}: Props) {
  const { t } = useTranslation("app");
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!USE_CUSTOM_WINDOW_CONTROLS || !maximizable) return;
    const w = getCurrentWindow();
    let disposed = false;
    let syncRevision = 0;
    let unlisten: (() => void) | undefined;
    const syncWindowState = async () => {
      const revision = ++syncRevision;
      const [nextMaximized, nextFullscreen] = await Promise.all([
        w.isMaximized(),
        w.isFullscreen(),
      ]);
      if (disposed || revision !== syncRevision) return;
      setMaximized(nextMaximized);
      setFullscreen(nextFullscreen);
    };
    const requestWindowStateSync = () => {
      void syncWindowState().catch((error) => {
        if (!disposed) console.error("window state sync failed:", error);
      });
    };
    requestWindowStateSync();
    void w
      .onResized(requestWindowStateSync)
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch((error) => {
        if (!disposed) console.error("window resize listener failed:", error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [maximizable]);

  if (!USE_CUSTOM_WINDOW_CONTROLS) return null;

  const w = getCurrentWindow();

  return (
    <div className="flex h-full shrink-0 items-center gap-0.5 pr-1">
      {minimizable && (
        <CtlButton
          ariaLabel={t("windowControls.minimize")}
          onClick={() => void w.minimize()}
        >
          <HugeiconsIcon icon={MinusSignIcon} size={12} strokeWidth={2} />
        </CtlButton>
      )}
      {maximizable && (
        <CtlButton
          ariaLabel={
            maximized || fullscreen
              ? t("windowControls.restore")
              : t("windowControls.maximize")
          }
          onClick={() => {
            if (fullscreen) {
              void invoke("set_fullscreen", { fullscreen: false });
            } else {
              void w.toggleMaximize();
            }
          }}
        >
          <HugeiconsIcon
            icon={maximized || fullscreen ? Copy01Icon : SquareIcon}
            size={12}
            strokeWidth={2}
          />
        </CtlButton>
      )}
      <CtlButton
        ariaLabel={t("common:close")}
        onClick={() => void w.close()}
        danger
      >
        <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
      </CtlButton>
    </div>
  );
}

function CtlButton({
  ariaLabel,
  onClick,
  children,
  danger,
}: {
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <Hint content={ariaLabel}>
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={(event) => {
          onClick();
          // 鼠标或触控点击不应把焦点外观带入随后的全屏状态；键盘触发的
          // click.detail 为 0，继续保留焦点以维持键盘导航可见性。
          if (event.detail > 0) event.currentTarget.blur();
        }}
        className={cn(
          "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors",
          danger
            ? "hover:bg-destructive/15 hover:text-destructive"
            : "hover:bg-accent hover:text-foreground",
        )}
      >
        {children}
      </button>
    </Hint>
  );
}
