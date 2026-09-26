/**
 * Alpha 主页面，所有分区位于同一个 Workbench 页面内。
 * 分区隐藏保留场景实例，布局只管理展示状态，不拥有行情和后台任务。
 */
import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import { readMotionDurationMs, readMotionEasing } from "@/lib/motion";
import { usePresence } from "@/lib/usePresence";
import { cn } from "@/lib/utils";
import { ConfiguredMarketChartScene } from "@/modules/alpha/chart/scenes/ConfiguredMarketChartScene";
import { AlphaServiceBoundary } from "@/modules/alpha/components/AlphaServiceBoundary";
import { AlphaDeskDivider } from "@/modules/alpha/desk/AlphaDeskDivider";
import { useAlphaDeskPreferences } from "@/modules/alpha/desk/preferences";
import { AlphaQueryProvider } from "@/modules/alpha/query";
import { BacktestResultsScene } from "@/modules/alpha/scenes/BacktestResultsScene";
import { DataManagementScene } from "@/modules/alpha/scenes/DataManagementScene";
import { SecurityDetailsScene } from "@/modules/alpha/scenes/SecurityDetailsScene";
import { TaskMonitorScene } from "@/modules/alpha/scenes/TaskMonitorScene";
import { WatchlistScene } from "@/modules/alpha/scenes/WatchlistScene";
import { WorkbenchPageWindow } from "@/modules/workbench/WorkbenchPageOverlays";
import {
  ChartAnalysisIcon,
  Database01Icon,
  GridIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

const AlphaSettingsDialog = lazy(() =>
  import("@/modules/alpha/components/AlphaSettingsDialog").then((module) => ({
    default: module.AlphaSettingsDialog,
  })),
);

/** 为 Alpha 页面接入查询缓存和服务边界。 */
export function AlphaDeskPage({ visible }: { visible: boolean }) {
  return (
    <AlphaQueryProvider>
      <AlphaDeskShell visible={visible} />
    </AlphaQueryProvider>
  );
}

/** 常驻工具栏与设置独立于服务状态，业务区域仍按服务可用性挂载。 */
function AlphaDeskShell({ visible }: { visible: boolean }) {
  const { t } = useTranslation("alpha");
  const preferences = useAlphaDeskPreferences();
  const id = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 懒加载宿主晚于页内对话框卸载，保留关闭时的退场过渡。
  const settingsPresence = usePresence(settingsOpen);
  return (
    <div className="flex h-full min-h-0 bg-background">
      <nav
        aria-label={t("desk.watchlistTools")}
        className="flex w-8 shrink-0 flex-col items-center gap-2 border-r py-2"
      >
        <Hint content={t("desk.watchlist")}>
          <Button
            size="icon-sm"
            variant={preferences.data?.leftOpen ? "secondary" : "ghost"}
            className="transition-none"
            disabled={!preferences.data}
            aria-label={t("desk.watchlist")}
            aria-expanded={preferences.data?.leftOpen ?? false}
            aria-controls={`${id}-watchlist`}
            onClick={() =>
              preferences.set("leftOpen", !preferences.data?.leftOpen)
            }
          >
            <HugeiconsIcon icon={GridIcon} size={16} />
          </Button>
        </Hint>
        <div className="mt-auto">
          <Hint content={t("desk.settings")}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("desk.settings")}
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen(true)}
            >
              <HugeiconsIcon icon={Settings01Icon} size={16} />
            </Button>
          </Hint>
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        <AlphaServiceBoundary visible={visible}>
          <AlphaDeskContent
            visible={visible}
            preferences={preferences}
            id={id}
          />
        </AlphaServiceBoundary>
      </div>
      {settingsPresence.mounted && (
        <Suspense fallback={null}>
          <AlphaSettingsDialog
            open={settingsOpen}
            visible={visible}
            onOpenChange={setSettingsOpen}
          />
        </Suspense>
      )}
    </div>
  );
}

function AlphaDeskContent({
  visible,
  preferences,
  id,
}: {
  visible: boolean;
  preferences: ReturnType<typeof useAlphaDeskPreferences>;
  id: string;
}) {
  const { t } = useTranslation("alpha");
  const [taskWindowOpen, setTaskWindowOpen] = useState(false);
  const [movableTaskWindowOpen, setMovableTaskWindowOpen] = useState(false);
  const state = preferences.data;
  const [displayedRight, setDisplayedRight] = useState(state?.right ?? null);
  // 收起只关闭业务可见性，保留最近的内容和标题随外壳退场。
  if (state?.right && state.right !== displayedRight) {
    setDisplayedRight(state.right);
  }
  const leftOpen = state?.leftOpen;
  const leftWidth = state?.leftWidth;
  const mainRef = useRef<HTMLElement>(null);
  const mainAnimationRef = useRef<Animation | null>(null);
  const previousLeftOpenRef = useRef(leftOpen);
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (leftOpen === undefined || leftWidth === undefined || !main) return;
    const previousOpen = previousLeftOpenRef.current;
    previousLeftOpenRef.current = leftOpen;
    if (previousOpen === undefined || previousOpen === leftOpen) return;

    const transform = mainAnimationRef.current
      ? getComputedStyle(main).transform
      : "none";
    const interruptedOffset =
      transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
    const startOffset =
      (leftOpen ? -1 : 1) * (leftWidth + 1) + interruptedOffset;
    mainAnimationRef.current?.cancel();
    const duration = readMotionDurationMs("--dur-pane", 150);
    if (Math.abs(startOffset) < 0.5 || duration <= 0 || !main.animate) return;

    // 面板宽度只在切换边界提交，图表不随动画逐帧重新测量。
    const animation = main.animate(
      [
        { transform: `translate3d(${startOffset}px, 0, 0)` },
        { transform: "translate3d(0, 0, 0)" },
      ],
      {
        duration,
        easing: readMotionEasing(
          "--ease-emphasized",
          "cubic-bezier(0.16, 1, 0.3, 1)",
        ),
      },
    );
    mainAnimationRef.current = animation;
    const clear = () => {
      if (mainAnimationRef.current === animation)
        mainAnimationRef.current = null;
    };
    animation.onfinish = clear;
    animation.oncancel = clear;
  }, [leftOpen, leftWidth]);
  useEffect(() => () => mainAnimationRef.current?.cancel(), []);
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
  const dataVisible = visible && state.view === "data";
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {preferences.saveError && (
        <p role="alert" className="shrink-0 p-2 text-xs text-destructive">
          {t("desk.saveFailed", { error: String(preferences.saveError) })}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="app-scrollbar min-w-0 flex-1 overflow-x-auto">
          <div
            className="relative flex h-full overflow-hidden"
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
              aria-hidden={!state.leftOpen}
              inert={!state.leftOpen}
              className={cn(
                "z-20 flex h-full shrink-0 flex-col overflow-hidden bg-background transition-[opacity,transform] duration-pane ease-emphasized motion-reduce:transition-none",
                !state.leftOpen &&
                  "pointer-events-none absolute inset-y-0 left-0",
              )}
              style={{
                width: state.leftWidth,
                opacity: state.leftOpen ? 1 : 0,
                transform: state.leftOpen
                  ? "translate3d(0, 0, 0)"
                  : "translate3d(-100%, 0, 0)",
              }}
            >
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
            <main ref={mainRef} className="flex min-w-0 flex-1 flex-col">
              <nav
                aria-label={t("desk.views")}
                className="flex h-10 shrink-0 items-center gap-1 border-b px-2"
              >
                {(["market", "backtests", "data"] as const).map((view) => (
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
              <section
                aria-label={t("desk.data")}
                hidden={state.view !== "data"}
                className="min-h-0 flex-1"
              >
                <DataManagementScene visible={dataVisible} />
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
              aria-hidden={!state.right}
              inert={!state.right}
              className={cn(
                // 右侧主区直接扩宽，退场保持实色并缓起，避免滑出与淡出叠加成瞬间消失。
                "z-20 flex h-full shrink-0 flex-col overflow-hidden bg-background transition-transform duration-pane motion-reduce:transition-none",
                state.right ? "ease-emphasized" : "ease-standard",
                !state.right &&
                  "pointer-events-none absolute inset-y-0 right-0",
              )}
              style={{
                width: state.rightWidth,
                transform: state.right
                  ? "translate3d(0, 0, 0)"
                  : "translate3d(100%, 0, 0)",
              }}
            >
              <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-1 border-b px-2 py-1">
                <strong className="text-xs">
                  {displayedRight && t(`desk.${displayedRight}`)}
                </strong>
                {displayedRight === "tasks" && (
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setTaskWindowOpen(true)}
                    >
                      {t("desk.openTaskWindow")}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setMovableTaskWindowOpen(true)}
                    >
                      {t("desk.openMovableTaskWindow")}
                    </Button>
                  </div>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => set("right", null)}
                >
                  {t("desk.collapse")}
                </Button>
              </div>
              <div
                hidden={displayedRight !== "security"}
                className="app-scrollbar min-h-0 flex-1 overflow-y-auto"
              >
                <SecurityDetailsScene
                  symbol={state.symbol}
                  visible={visible && state.right === "security"}
                />
              </div>
              <div
                hidden={displayedRight !== "tasks"}
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
                className="transition-none"
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
      <WorkbenchPageWindow
        open={taskWindowOpen}
        onOpenChange={setTaskWindowOpen}
        title={t("desk.tasks")}
        className="w-96"
      >
        <TaskMonitorScene visible={visible && taskWindowOpen} />
      </WorkbenchPageWindow>
      <WorkbenchPageWindow
        open={movableTaskWindowOpen}
        onOpenChange={setMovableTaskWindowOpen}
        title={t("desk.movableTaskWindow")}
        draggable
        className="top-16 right-16 w-96"
      >
        <TaskMonitorScene visible={visible && movableTaskWindowOpen} />
      </WorkbenchPageWindow>
    </div>
  );
}
