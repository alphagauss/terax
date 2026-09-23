/**
 * 独立的三栏 Alpha 实验页，所有分区位于同一个 Workbench 页面内。
 * 分区隐藏保留场景实例，布局只管理展示状态，不拥有行情和后台任务。
 */
import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import { cn } from "@/lib/utils";
import { ConfiguredMarketChartScene } from "@/modules/alpha/chart/scenes/ConfiguredMarketChartScene";
import { AlphaServiceBoundary } from "@/modules/alpha/components/AlphaServiceBoundary";
import { AlphaDeskDivider } from "@/modules/alpha/desk/AlphaDeskDivider";
import { useAlphaDeskPreferences } from "@/modules/alpha/desk/preferences";
import { AlphaQueryProvider } from "@/modules/alpha/query";
import { BacktestResultsScene } from "@/modules/alpha/scenes/BacktestResultsScene";
import { SecurityDetailsScene } from "@/modules/alpha/scenes/SecurityDetailsScene";
import { TaskMonitorScene } from "@/modules/alpha/scenes/TaskMonitorScene";
import { WatchlistScene } from "@/modules/alpha/scenes/WatchlistScene";
import {
  ChartAnalysisIcon,
  Database01Icon,
  GridIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

/** 为三栏页接入与其他 Alpha 页面相同的查询缓存和服务边界。 */
export function AlphaDeskPage({ visible }: { visible: boolean }) {
  return (
    <AlphaQueryProvider>
      <AlphaServiceBoundary visible={visible}>
        <AlphaDeskContent visible={visible} />
      </AlphaServiceBoundary>
    </AlphaQueryProvider>
  );
}

function AlphaDeskContent({ visible }: { visible: boolean }) {
  const { t } = useTranslation("alpha");
  const preferences = useAlphaDeskPreferences();
  const id = useId();
  const state = preferences.data;
  if (!state)
    return (
      <div
        role={preferences.error ? "alert" : "status"}
        className="p-4 text-xs"
      >
        {preferences.error ? (
          <>
            <p>{String(preferences.error)}</p>
            <Button
              variant="outline"
              onClick={() => void preferences.refetch()}
            >
              {t("common.retry")}
            </Button>
          </>
        ) : (
          t("common.loading")
        )}
      </div>
    );
  const set = preferences.set;
  const marketVisible = visible && state.view === "market";
  const backtestsVisible = visible && state.view === "backtests";
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {preferences.saveError && (
        <p role="alert" className="shrink-0 p-2 text-xs text-destructive">
          {t("desk.saveFailed", { error: String(preferences.saveError) })}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t("desk.watchlistTools")}
          className="flex w-8 shrink-0 flex-col items-center gap-2 border-r py-2"
        >
          <Hint content={t("desk.watchlist")}>
            <Button
              size="icon-sm"
              variant={state.leftOpen ? "secondary" : "ghost"}
              aria-label={t("desk.watchlist")}
              aria-expanded={state.leftOpen}
              aria-controls={`${id}-watchlist`}
              onClick={() => set("leftOpen", !state.leftOpen)}
            >
              <HugeiconsIcon icon={GridIcon} size={16} />
            </Button>
          </Hint>
        </nav>
        <div className="app-scrollbar min-w-0 flex-1 overflow-x-auto">
          <div
            className="flex h-full"
            style={{
              minWidth:
                360 +
                (state.leftOpen ? state.leftWidth + 1 : 0) +
                (state.right ? state.rightWidth + 1 : 0),
            }}
          >
            <aside
              id={`${id}-watchlist`}
              aria-label={t("desk.watchlist")}
              hidden={!state.leftOpen}
              className={cn(
                "h-full shrink-0 flex-col",
                state.leftOpen && "flex",
              )}
              style={{ width: state.leftWidth }}
            >
              <div className="flex h-10 shrink-0 items-center justify-between border-b px-2">
                <strong className="text-xs">{t("desk.watchlist")}</strong>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => set("leftOpen", false)}
                >
                  {t("desk.collapse")}
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <WatchlistScene
                  visible={visible && state.leftOpen}
                  symbol={state.symbol}
                  onSelect={(symbol) => set("symbol", symbol)}
                />
              </div>
            </aside>
            {state.leftOpen && (
              <AlphaDeskDivider
                label={t("desk.resizeWatchlist")}
                width={state.leftWidth}
                onCommit={(width) => set("leftWidth", width)}
              />
            )}
            <main className="flex min-w-0 flex-1 flex-col">
              <nav
                aria-label={t("desk.views")}
                className="flex h-10 shrink-0 items-center gap-1 border-b px-2"
              >
                {(["market", "backtests"] as const).map((view) => (
                  <Button
                    key={view}
                    size="sm"
                    variant={state.view === view ? "secondary" : "ghost"}
                    aria-pressed={state.view === view}
                    onClick={() => set("view", view)}
                  >
                    {t(`desk.${view}`)}
                  </Button>
                ))}
                <span className="ml-auto truncate text-[10px] text-muted-foreground">
                  {t("desk.experimental")}
                </span>
              </nav>
              <section
                aria-label={t("desk.market")}
                hidden={state.view !== "market"}
                className={cn(
                  "min-h-0 flex-1 flex-col",
                  state.view === "market" && "flex",
                )}
              >
                <div className="shrink-0 border-b px-3 py-2 font-mono text-xs">
                  {state.symbol}
                </div>
                <div className="min-h-0 flex-1">
                  <ConfiguredMarketChartScene
                    vtSymbol={state.symbol}
                    visible={marketVisible}
                    config={state.chart}
                    onConfigChange={(chart) => set("chart", chart)}
                  />
                </div>
              </section>
              <section
                aria-label={t("desk.backtests")}
                hidden={state.view !== "backtests"}
                className="min-h-0 flex-1"
              >
                <BacktestResultsScene visible={backtestsVisible} />
              </section>
            </main>
            {state.right && (
              <AlphaDeskDivider
                label={t("desk.resizeDetails")}
                width={state.rightWidth}
                reverse
                onCommit={(width) => set("rightWidth", width)}
              />
            )}
            <aside
              id={`${id}-details`}
              hidden={!state.right}
              className={cn("h-full shrink-0 flex-col", state.right && "flex")}
              style={{ width: state.rightWidth }}
            >
              <div className="flex h-10 shrink-0 items-center justify-between border-b px-2">
                <strong className="text-xs">
                  {state.right && t(`desk.${state.right}`)}
                </strong>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => set("right", null)}
                >
                  {t("desk.collapse")}
                </Button>
              </div>
              <div
                hidden={state.right !== "security"}
                className="app-scrollbar min-h-0 flex-1 overflow-y-auto"
              >
                <SecurityDetailsScene
                  symbol={state.symbol}
                  visible={visible && state.right === "security"}
                />
              </div>
              <div
                hidden={state.right !== "tasks"}
                className="app-scrollbar min-h-0 flex-1 overflow-y-auto"
              >
                <TaskMonitorScene
                  visible={visible && state.right === "tasks"}
                />
              </div>
            </aside>
          </div>
        </div>
        <nav
          aria-label={t("desk.tools")}
          className="flex w-8 shrink-0 flex-col items-center gap-2 border-l py-2"
        >
          {(
            [
              { key: "security", icon: Database01Icon },
              { key: "tasks", icon: ChartAnalysisIcon },
            ] as const
          ).map(({ key, icon }) => (
            <Hint key={key} content={t(`desk.${key}`)}>
              <Button
                size="icon-sm"
                variant={state.right === key ? "secondary" : "ghost"}
                aria-label={t(`desk.${key}`)}
                aria-expanded={state.right === key}
                aria-controls={`${id}-details`}
                onClick={() => set("right", state.right === key ? null : key)}
              >
                <HugeiconsIcon icon={icon} size={16} />
              </Button>
            </Hint>
          ))}
        </nav>
      </div>
    </div>
  );
}
