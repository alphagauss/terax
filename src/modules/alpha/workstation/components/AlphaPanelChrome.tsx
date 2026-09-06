/**
 * 本文件实现 Alpha 工作台面板的统一标题栏。
 * 标题栏承载拖动手柄、标的跟随或固定切换和删除操作，不接触面板业务内容。
 */

import { Button } from "@/components/controls/button";
import type {
  AlphaPanelInstance,
  AlphaSymbolBinding,
} from "@/modules/alpha/workstation/model";
import type { AlphaPanelRegistry } from "@/modules/alpha/workstation/registry";
import { resolveAlphaPanelSymbol } from "@/modules/alpha/workstation/state";
import {
  Delete02Icon,
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
};

/** 渲染与业务面板解耦的工作台标题栏和面板级操作。 */
export function AlphaPanelChrome({
  panel,
  registry,
  mainSymbol,
  onBindingChange,
  onRemove,
}: Props) {
  const { t } = useTranslation("alpha");
  const descriptor = registry.get(panel.type);
  const vtSymbol = resolveAlphaPanelSymbol(panel.binding, mainSymbol);
  const followed = panel.binding.mode === "follow";

  return (
    <header className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 bg-card/80 px-1.5">
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
        <Button
          type="button"
          variant={followed ? "ghost" : "secondary"}
          size="xs"
          className="shrink-0"
          aria-pressed={!followed}
          title={
            followed
              ? t("workstation.panel.pinCurrent", { symbol: mainSymbol })
              : t("workstation.panel.restoreFollow")
          }
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
            followed ? "workstation.panel.follow" : "workstation.panel.pinned",
          )}
        </Button>
      ) : null}

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        title={t("workstation.panel.remove")}
        aria-label={t("workstation.panel.remove")}
        onClick={onRemove}
      >
        <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.8} />
      </Button>
    </header>
  );
}
