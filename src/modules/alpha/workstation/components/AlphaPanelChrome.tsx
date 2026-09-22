/**
 * 本文件实现 Alpha 工作台面板的统一标题栏。
 * 标题栏承载拖动手柄、标的绑定、折叠与删除操作，不接触面板业务内容。
 */

import { Hint } from "@/components/controls/tooltip";
import { Button } from "@/components/controls/button";
import type {
  AlphaPanelInstance,
  AlphaSymbolBinding,
} from "@/modules/alpha/workstation/model";
import type { AlphaPanelRegistry } from "@/modules/alpha/workstation/registry";
import { resolveAlphaPanelSymbol } from "@/modules/alpha/workstation/state";
import { ALPHA_PANEL_HEADER_HEIGHT } from "@/modules/alpha/workstation/panelGeometry";
import {
  Delete02Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  DragDropVerticalIcon,
  Link01Icon,
  PinIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslation } from "react-i18next";

type Props = {
  panel: AlphaPanelInstance;
  registry: AlphaPanelRegistry;
  mainSymbol: string;
  onBindingChange: (binding: AlphaSymbolBinding) => void;
  onRemove: () => void;
  onToggleCollapsed: () => void;
};

/** 渲染与业务面板解耦的工作台标题栏和面板级操作。 */
export function AlphaPanelChrome({
  panel,
  registry,
  mainSymbol,
  onBindingChange,
  onRemove,
  onToggleCollapsed,
}: Props) {
  const { t } = useTranslation("alpha");
  const descriptor = registry.get(panel.type);
  const vtSymbol = resolveAlphaPanelSymbol(panel.binding, mainSymbol);
  const followed = panel.binding.mode === "follow";
  const collapseLabel = t(
    panel.collapsed ? "workstation.panel.expand" : "workstation.panel.collapse",
  );

  return (
    <header
      className="pointer-events-auto relative z-10 flex shrink-0 items-center gap-1 rounded-t border border-border bg-card px-1.5"
      style={{ height: ALPHA_PANEL_HEADER_HEIGHT }}
    >
      <div className="alpha-panel-drag-handle flex min-w-0 flex-1 cursor-grab items-center gap-1.5 px-0.5 text-xs active:cursor-grabbing">
        <HugeiconsIcon
          icon={DragDropVerticalIcon}
          size={13}
          strokeWidth={1.7}
          className="shrink-0 text-muted-foreground"
        />
        <span className="truncate font-medium text-foreground">
          {descriptor ? t(descriptor.titleKey) : panel.type}
        </span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {vtSymbol}
        </span>
      </div>

      {descriptor?.pinnable ? (
        <Hint
          content={
            followed
              ? t("workstation.panel.pinCurrent", { symbol: mainSymbol })
              : t("workstation.panel.restoreFollow")
          }
        >
          <Button
            aria-label={
              followed
                ? t("workstation.panel.pinCurrent", { symbol: mainSymbol })
                : t("workstation.panel.restoreFollow")
            }
            type="button"
            variant={followed ? "ghost" : "secondary"}
            size="xs"
            className="shrink-0"
            aria-pressed={!followed}
            onClick={() =>
              onBindingChange(
                followed
                  ? { mode: "pinned", vtSymbol: mainSymbol }
                  : { mode: "follow" },
              )
            }
          >
            <HugeiconsIcon
              icon={followed ? Link01Icon : PinIcon}
              size={11}
              strokeWidth={1.8}
            />
            {t(
              followed
                ? "workstation.panel.follow"
                : "workstation.panel.pinned",
            )}
          </Button>
        </Hint>
      ) : null}

      <Hint content={collapseLabel}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label={collapseLabel}
          aria-expanded={!panel.collapsed}
          onClick={onToggleCollapsed}
        >
          <HugeiconsIcon
            icon={panel.collapsed ? ArrowDown01Icon : ArrowUp01Icon}
            size={12}
            strokeWidth={1.8}
          />
        </Button>
      </Hint>

      <Hint content={t("workstation.panel.remove")}>
        <Button
          type="button"
          variant="ghost-destructive-hover"
          size="icon-xs"
          className="shrink-0"
          aria-label={t("workstation.panel.remove")}
          onClick={onRemove}
        >
          <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.8} />
        </Button>
      </Hint>
    </header>
  );
}
