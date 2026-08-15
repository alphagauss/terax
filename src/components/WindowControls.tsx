/**
 * 本文件渲染 Windows 和 Linux 的统一窗口控制按钮。
 * 调用方根据原生窗口真实能力决定是否显示最小化和最大化，关闭始终可用。
 */

import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Copy01Icon,
  MinusSignIcon,
  SquareIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  minimizable?: boolean;
  maximizable?: boolean;
};

/** 渲染与当前原生窗口能力一致的最小化、最大化和关闭按钮。 */
export function WindowControls({
  minimizable = true,
  maximizable = true,
}: Props) {
  const { t } = useTranslation("app");
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!USE_CUSTOM_WINDOW_CONTROLS || !maximizable) return;
    const w = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void w.isMaximized().then(setMaximized);
    void w
      .onResized(() => {
        void w.isMaximized().then(setMaximized);
      })
      .then((un) => {
        unlisten = un;
      });
    return () => unlisten?.();
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
            maximized
              ? t("windowControls.restore")
              : t("windowControls.maximize")
          }
          onClick={() => void w.toggleMaximize()}
        >
          <HugeiconsIcon
            icon={maximized ? Copy01Icon : SquareIcon}
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
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors",
        danger
          ? "hover:bg-destructive/15 hover:text-destructive"
          : "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
