/**
 * 本文件渲染主窗口标题栏、全局入口和窗口控制区域。
 * Agent 通知导航直接使用 Workbench 标签 ID。
 */

import { Hint } from "@/components/controls/tooltip";
import { Button } from "@/components/controls/button";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { NotificationBell } from "@/modules/agents";
import { useTheme } from "@/modules/theme";
import {
  CommandIcon,
  Moon02Icon,
  Settings01Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  onToggleSidebar: () => void;
  onOpenCommandPalette: () => void;
  onActivateAgent: (tabId: number) => void;
  onActivateLocalAgent: (sessionId?: string) => void;
  onOpenSettings: () => void;
  onToggleSecondarySidebar?: () => void;
  secondarySidebarOpen?: boolean;
  spaceSwitcher: ReactNode;
};

/** 渲染应用标题栏并连接全局导航与窗口操作。 */
export function Header({
  onToggleSidebar,
  onOpenCommandPalette,
  onActivateAgent,
  onActivateLocalAgent,
  onOpenSettings,
  onToggleSecondarySidebar,
  secondarySidebarOpen = false,
  spaceSwitcher,
}: Props) {
  const { t } = useTranslation("header");
  const { resolvedMode, setMode } = useTheme();
  const settingsButton = (
    <Hint content={t("settings")}>
      <Button
        aria-label={t("settings")}
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={onOpenSettings}
      >
        <HugeiconsIcon icon={Settings01Icon} size={15} strokeWidth={1.75} />
      </Button>
    </Hint>
  );

  const secondarySidebarButton = onToggleSecondarySidebar ? (
    <Hint content={t("toggleSecondarySidebar")}>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={onToggleSecondarySidebar}
        aria-label={t("toggleSecondarySidebar")}
        aria-pressed={secondarySidebarOpen}
      >
        <HugeiconsIcon icon={SidebarRightIcon} size={15} strokeWidth={1.75} />
      </Button>
    </Hint>
  ) : null;

  const themeButton = (
    <Hint content={t("toggleTheme")}>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={() => setMode(resolvedMode === "dark" ? "light" : "dark")}
        aria-label={t("toggleTheme")}
      >
        <HugeiconsIcon
          icon={resolvedMode === "dark" ? Sun03Icon : Moon02Icon}
          size={15}
          strokeWidth={1.75}
        />
      </Button>
    </Hint>
  );

  return (
    <div
      data-tauri-drag-region
      className={`flex h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-card select-none ${
        IS_MAC ? "pr-2 pl-20" : "pr-0 pl-2"
      }`}
    >
      <div className="flex shrink-0 items-center gap-0.5">
        <Hint content={t("toggleSidebar")}>
          <Button
            aria-label={t("toggleSidebar")}
            onClick={onToggleSidebar}
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
          >
            <HugeiconsIcon
              icon={SidebarLeftIcon}
              size={18}
              strokeWidth={1.75}
            />
          </Button>
        </Hint>

        <Hint content={t("commandPalette")}>
          <Button
            aria-label={t("commandPalette")}
            size="icon-sm"
            variant="ghost"
            onClick={onOpenCommandPalette}
            className="shrink-0 gap-1.5 px-1.5"
          >
            <HugeiconsIcon icon={CommandIcon} size={14} strokeWidth={1.75} />
          </Button>
        </Hint>

        <NotificationBell
          onActivate={onActivateAgent}
          onActivateLocal={onActivateLocalAgent}
        />
      </div>

      {!IS_MAC && <span className="mx-1 h-full w-px shrink-0 bg-border/70" />}

      {IS_MAC && <span className="mr-1 h-full w-px shrink-0 bg-border/70" />}

      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        data-tauri-drag-region
      >
        {spaceSwitcher}
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
      </div>

      {settingsButton}
      {themeButton}
      {secondarySidebarButton}

      {USE_CUSTOM_WINDOW_CONTROLS && (
        <>
          <span className="ml-1 h-5 w-px shrink-0 bg-border/60" />
          <WindowControls />
        </>
      )}
    </div>
  );
}
