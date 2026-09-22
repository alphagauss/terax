/**
 * 本文件实现 Alpha 综合工作台页面。
 * 页面组合共享状态、同步开关、内置模板、自由网格和稳定面板池，所有窗口读写同一份 Alpha 配置。
 */

import { Hint } from "@/components/controls/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Button } from "@/components/controls/button";
import { Input } from "@/components/controls/input";
import { AlphaLoading } from "@/modules/alpha/components/AlphaPagePrimitives";
import { ChartSyncProvider } from "@/modules/alpha/chart/sync/ChartSyncContext";
import { AlphaQueryProvider } from "@/modules/alpha/query";
import { AlphaPanelGrid } from "@/modules/alpha/workstation/components/AlphaPanelGrid";
import { AlphaPanelPool } from "@/modules/alpha/workstation/components/AlphaPanelPool";
import {
  normalizeAlphaVtSymbol,
  type AlphaGridItem,
  type AlphaPanelConfig,
  type AlphaSymbolBinding,
} from "@/modules/alpha/workstation/model";
import {
  updateAlphaPanelConfig,
  updateAlphaPanelGeometry,
  raiseAlphaPanel,
  toggleAlphaPanelCollapsed,
} from "@/modules/alpha/workstation/layout";
import { resolveAlphaPanelSymbol } from "@/modules/alpha/workstation/state";
import { alphaPanelRegistry } from "@/modules/alpha/workstation/panelRegistry";
import {
  updateAlphaWorkstationState,
  useAlphaWorkstationSnapshot,
} from "@/modules/alpha/workstation/store";
import {
  ALPHA_WORKSTATION_TEMPLATES,
  instantiateAlphaWorkstationTemplate,
} from "@/modules/alpha/workstation/templates";
import {
  ChartRelationshipIcon,
  Cursor02Icon,
  GridIcon,
  LockIcon,
} from "@hugeicons/core-free-icons";
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
  const [revealRequest, setRevealRequest] = useState<{
    panelId: string;
  } | null>(null);
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

  const commitGridItem = useCallback((item: AlphaGridItem) => {
    updateAlphaWorkstationState((current) => {
      const layout = updateAlphaPanelGeometry(current.layout, item);
      return layout === current.layout ? current : { ...current, layout };
    });
  }, []);

  const raisePanel = useCallback((panelId: string) => {
    updateAlphaWorkstationState((current) => {
      const layout = raiseAlphaPanel(current.layout, panelId);
      return layout === current.layout ? current : { ...current, layout };
    });
  }, []);

  const toggleCollapsed = useCallback((panelId: string) => {
    updateAlphaWorkstationState((current) => ({
      ...current,
      layout: toggleAlphaPanelCollapsed(current.layout, panelId),
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

  const changePanelConfig = useCallback(
    (panelId: string, config: AlphaPanelConfig) => {
      updateAlphaWorkstationState((current) => {
        const layout = updateAlphaPanelConfig(
          current.layout,
          panelId,
          config,
          alphaPanelRegistry,
        );
        return layout === current.layout ? current : { ...current, layout };
      });
    },
    [],
  );

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
            className="h-7 w-40 font-mono uppercase"
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
            <Button size="sm" type="button" variant="outline">
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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" type="button" variant="outline">
              {t("workstation.panelList.action")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-80 min-w-56 overflow-y-auto"
          >
            {state.layout.panels.length === 0 ? (
              <DropdownMenuItem disabled>
                {t("workstation.panelList.empty")}
              </DropdownMenuItem>
            ) : (
              state.layout.panels.map((panel) => {
                const descriptor = alphaPanelRegistry.get(panel.type);
                const symbol = resolveAlphaPanelSymbol(
                  panel.binding,
                  state.mainSymbol,
                );
                const matching = state.layout.panels.filter(
                  (candidate) =>
                    candidate.type === panel.type &&
                    resolveAlphaPanelSymbol(
                      candidate.binding,
                      state.mainSymbol,
                    ) === symbol,
                );
                const title = descriptor ? t(descriptor.titleKey) : panel.type;
                const label = `${title} · ${symbol}${matching.length > 1 ? ` (${matching.findIndex((candidate) => candidate.id === panel.id) + 1})` : ""}`;
                return (
                  <DropdownMenuItem
                    key={panel.id}
                    onSelect={() => {
                      raisePanel(panel.id);
                      setRevealRequest({ panelId: panel.id });
                    }}
                  >
                    <span className="truncate">{label}</span>
                    {panel.collapsed ? (
                      <span className="ml-auto text-muted-foreground">
                        {t("workstation.panelList.collapsed")}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Hint content={t("workstation.sync.range")}>
          <Button
            size="sm"
            type="button"
            variant={state.chartSync.rangeEnabled ? "secondary" : "outline"}
            aria-label={t("workstation.sync.range")}
            aria-pressed={state.chartSync.rangeEnabled}
            data-alpha-chart-range-sync
            onClick={() =>
              updateAlphaWorkstationState((current) => ({
                ...current,
                chartSync: {
                  ...current.chartSync,
                  rangeEnabled: !current.chartSync.rangeEnabled,
                },
              }))
            }
          >
            <HugeiconsIcon
              icon={ChartRelationshipIcon}
              size={12}
              strokeWidth={1.8}
            />
            {t("workstation.sync.range")}
          </Button>
        </Hint>

        <Hint content={t("workstation.sync.crosshair")}>
          <Button
            size="sm"
            type="button"
            variant={state.chartSync.crosshairEnabled ? "secondary" : "outline"}
            aria-label={t("workstation.sync.crosshair")}
            aria-pressed={state.chartSync.crosshairEnabled}
            data-alpha-chart-crosshair-sync
            onClick={() =>
              updateAlphaWorkstationState((current) => ({
                ...current,
                chartSync: {
                  ...current.chartSync,
                  crosshairEnabled: !current.chartSync.crosshairEnabled,
                },
              }))
            }
          >
            <HugeiconsIcon icon={Cursor02Icon} size={12} strokeWidth={1.8} />
            {t("workstation.sync.crosshair")}
          </Button>
        </Hint>

        <Button
          size="sm"
          type="button"
          variant={state.locked ? "secondary" : "outline"}
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

      <ChartSyncProvider config={state.chartSync}>
        <AlphaPanelPool
          panels={state.layout.panels}
          registry={alphaPanelRegistry}
          mainSymbol={state.mainSymbol}
          visible={visible}
          onPanelConfigChange={changePanelConfig}
        >
          <AlphaPanelGrid
            state={state}
            registry={alphaPanelRegistry}
            onGridItemCommit={commitGridItem}
            onBindingChange={changeBinding}
            onRemovePanel={removePanel}
            onToggleCollapsed={toggleCollapsed}
            onRaisePanel={raisePanel}
            revealRequest={revealRequest}
          />
        </AlphaPanelPool>
      </ChartSyncProvider>
    </div>
  );
}
