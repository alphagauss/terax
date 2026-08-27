/**
 * 本文件实现 Alpha 综合工作台页面。
 * 页面组合共享状态、内置模板、24 列网格和稳定面板池，所有窗口读写同一份 Alpha 配置。
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlphaLoading } from "@/modules/alpha/components/AlphaPagePrimitives";
import { AlphaQueryProvider } from "@/modules/alpha/query";
import { AlphaPanelGrid } from "@/modules/alpha/workstation/components/AlphaPanelGrid";
import { AlphaPanelPool } from "@/modules/alpha/workstation/components/AlphaPanelPool";
import {
  normalizeAlphaVtSymbol,
  type AlphaGridItem,
  type AlphaSymbolBinding,
} from "@/modules/alpha/workstation/model";
import { alphaPanelRegistry } from "@/modules/alpha/workstation/panelRegistry";
import {
  updateAlphaWorkstationState,
  useAlphaWorkstationSnapshot,
} from "@/modules/alpha/workstation/store";
import {
  ALPHA_WORKSTATION_TEMPLATES,
  instantiateAlphaWorkstationTemplate,
} from "@/modules/alpha/workstation/templates";
import { GridIcon, LockIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  visible: boolean;
};

/** 为工作台接入共享 Alpha 查询上下文。 */
export function AlphaWorkstationPage(props: Props) {
  return (
    <AlphaQueryProvider>
      <AlphaWorkstationPageContent {...props} />
    </AlphaQueryProvider>
  );
}

/** 组合工作台工具栏、共享持久状态和稳定网格。 */
function AlphaWorkstationPageContent({ visible }: Props) {
  const { t } = useTranslation("alpha");
  const snapshot = useAlphaWorkstationSnapshot();
  const [symbolDraft, setSymbolDraft] = useState("");
  const [symbolError, setSymbolError] = useState(false);
  const state = snapshot.state;
  const mainSymbol = state?.mainSymbol ?? "";
  const symbolInputId = useId();
  const symbolErrorId = `${symbolInputId}-error`;

  useEffect(() => {
    if (!mainSymbol) return;
    setSymbolDraft(mainSymbol);
    setSymbolError(false);
  }, [mainSymbol]);

  const commitSymbol = useCallback(() => {
    const mainSymbol = normalizeAlphaVtSymbol(symbolDraft);
    if (!mainSymbol) {
      setSymbolError(true);
      return;
    }
    setSymbolDraft(mainSymbol);
    setSymbolError(false);
    updateAlphaWorkstationState((current) => ({ ...current, mainSymbol }));
  }, [symbolDraft]);

  const commitGrid = useCallback((grid: AlphaGridItem[]) => {
    updateAlphaWorkstationState((current) => ({
      ...current,
      layout: { ...current.layout, grid },
    }));
  }, []);

  const changeBinding = useCallback(
    (panelId: string, binding: AlphaSymbolBinding) => {
      updateAlphaWorkstationState((current) => ({
        ...current,
        layout: {
          ...current.layout,
          panels: current.layout.panels.map((panel) =>
            panel.id === panelId ? { ...panel, binding } : panel,
          ),
        },
      }));
    },
    [],
  );

  const removePanel = useCallback((panelId: string) => {
    updateAlphaWorkstationState((current) => ({
      ...current,
      layout: {
        ...current.layout,
        panels: current.layout.panels.filter((panel) => panel.id !== panelId),
        grid: current.layout.grid.filter((item) => item.panelId !== panelId),
      },
    }));
  }, []);

  if (!snapshot.hydrated || !state) {
    return <AlphaLoading label={t("common.loading")} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border/70 bg-card px-2 py-1">
        <div className="flex items-center gap-1.5">
          <label
            htmlFor={symbolInputId}
            className="text-[11px] text-muted-foreground"
          >
            {t("workstation.mainSymbol")}
          </label>
          <Input
            id={symbolInputId}
            value={symbolDraft}
            spellCheck={false}
            aria-invalid={symbolError}
            aria-describedby={symbolError ? symbolErrorId : undefined}
            className="h-7 w-40 font-mono text-xs uppercase"
            onChange={(event) => setSymbolDraft(event.target.value)}
            onBlur={commitSymbol}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitSymbol();
            }}
          />
          {symbolError ? (
            <span id={symbolErrorId} className="text-[10px] text-destructive">
              {t("workstation.invalidSymbol")}
            </span>
          ) : null}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[11px]"
            >
              <HugeiconsIcon icon={GridIcon} size={12} strokeWidth={1.8} />
              {t("workstation.templates.action")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-64">
            {ALPHA_WORKSTATION_TEMPLATES.map((template) => (
              <DropdownMenuItem
                key={template.id}
                className="flex-col items-start gap-0.5"
                onSelect={() =>
                  updateAlphaWorkstationState((current) => ({
                    ...current,
                    layout: instantiateAlphaWorkstationTemplate(template.id),
                  }))
                }
              >
                <span>{t(template.titleKey)}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t(template.descriptionKey)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          type="button"
          variant={state.locked ? "secondary" : "outline"}
          size="sm"
          className="h-7 gap-1.5 text-[11px]"
          aria-pressed={state.locked}
          onClick={() =>
            updateAlphaWorkstationState((current) => ({
              ...current,
              locked: !current.locked,
            }))
          }
        >
          <HugeiconsIcon icon={LockIcon} size={12} strokeWidth={1.8} />
          {t(state.locked ? "workstation.unlock" : "workstation.lock")}
        </Button>
      </header>

      <AlphaPanelPool
        panels={state.layout.panels}
        registry={alphaPanelRegistry}
        mainSymbol={state.mainSymbol}
        visible={visible}
      >
        <AlphaPanelGrid
          state={state}
          registry={alphaPanelRegistry}
          onGridCommit={commitGrid}
          onBindingChange={changeBinding}
          onRemovePanel={removePanel}
        />
      </AlphaPanelPool>
    </div>
  );
}
