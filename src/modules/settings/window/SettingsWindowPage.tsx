/**
 * 本文件实现设置辅助窗口的标签导航与内容布局。
 * 页面复用公共辅助窗口外壳，只持有设置分区选择，不管理原生窗口生命周期。
 */

import { AuxiliaryWindowLayout } from "@/auxiliary/AuxiliaryWindowLayout";
import { useAuxiliaryOpenRequest } from "@/auxiliary/useAuxiliaryOpenRequest";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { WINDOW_DRAG_REGION } from "@/lib/windowChrome";
import {
  isSettingsTab,
  type SettingsTab,
} from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { AboutSection } from "@/settings/sections/AboutSection";
import { AgentsSection } from "@/settings/sections/AgentsSection";
import { EditorSection } from "@/settings/sections/EditorSection";
import { GeneralSection } from "@/settings/sections/GeneralSection";
import { ModelsSection } from "@/settings/sections/ModelsSection";
import { RemoteSection } from "@/settings/sections/RemoteSection";
import { ShortcutsSection } from "@/settings/sections/ShortcutsSection";
import { ThemesSection } from "@/settings/sections/ThemesSection";
import AiScanIcon from "@hugeicons/core-free-icons/AiScanIcon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import KeyboardIcon from "@hugeicons/core-free-icons/KeyboardIcon";
import PaintBoardIcon from "@hugeicons/core-free-icons/PaintBoardIcon";
import PlugIcon from "@hugeicons/core-free-icons/Plug01Icon";
import ServerStack03Icon from "@hugeicons/core-free-icons/ServerStack03Icon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import SourceCodeIcon from "@hugeicons/core-free-icons/SourceCodeIcon";
import UserMultiple02Icon from "@hugeicons/core-free-icons/UserMultiple02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type ComponentType,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

const ChannelsSection = lazy(() =>
  import("@/modules/channels/components/ChannelsSection").then((module) => ({
    default: module.ChannelsSection,
  })),
);

const TABS: {
  id: SettingsTab;
  icon: typeof Settings01Icon;
  component: ComponentType;
}[] = [
  { id: "general", icon: Settings01Icon, component: GeneralSection },
  { id: "editor", icon: SourceCodeIcon, component: EditorSection },
  { id: "themes", icon: PaintBoardIcon, component: ThemesSection },
  { id: "shortcuts", icon: KeyboardIcon, component: ShortcutsSection },
  { id: "models", icon: AiScanIcon, component: ModelsSection },
  { id: "agents", icon: UserMultiple02Icon, component: AgentsSection },
  { id: "channels", icon: PlugIcon, component: ChannelsSection },
  { id: "remote", icon: ServerStack03Icon, component: RemoteSection },
  { id: "about", icon: InformationCircleIcon, component: AboutSection },
];

/** 从原生层验证过的初始 URL 中读取设置分区。 */
function readInitialTab(): SettingsTab {
  if (typeof window === "undefined") return "general";
  const tab = new URL(window.location.href).searchParams.get("tab");
  return isSettingsTab(tab) ? tab : "general";
}

/** 只滚动标题栏内的目标标签，不改变设置正文的滚动位置。 */
function revealTab(tab: HTMLElement | null | undefined) {
  tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** 渲染设置辅助窗口，并响应统一窗口事件中的设置分区请求。 */
export function SettingsWindowPage() {
  const { t } = useTranslation("settings");
  const [active, setActive] = useState<SettingsTab>(readInitialTab);
  const navigationRef = useRef<HTMLDivElement>(null);
  const openEnvelope = useAuxiliaryOpenRequest();
  const init = usePreferencesStore((state) => state.init);
  const ActiveSection = TABS.find((tab) => tab.id === active)?.component;

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const viewport = navigationRef.current;
    if (!viewport) return;
    // 只观察轻量标题栏，不监听设置表单或触发 React 布局状态。
    const observer = new ResizeObserver(() =>
      revealTab(viewport.querySelector('[role="tab"][data-state="active"]')),
    );
    observer.observe(viewport);
    if (viewport.firstElementChild)
      observer.observe(viewport.firstElementChild);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    revealTab(
      navigationRef.current?.querySelector(`[data-settings-tab="${active}"]`),
    );
  }, [active]);

  useEffect(() => {
    const request = openEnvelope?.request;
    if (request?.kind === "settings" && isSettingsTab(request.tab)) {
      setActive(request.tab);
    }
  }, [openEnvelope]);

  const headerContent = (
    <Tabs
      value={active}
      onValueChange={(value) => setActive(value as SettingsTab)}
      orientation="horizontal"
      className="flex min-w-0 flex-1 items-center"
      {...WINDOW_DRAG_REGION}
    >
      <div
        ref={navigationRef}
        {...WINDOW_DRAG_REGION}
        className="w-full min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-smooth motion-reduce:scroll-auto"
        onWheel={(event) => {
          // 普通鼠标的纵向滚轮也能浏览横向标签；触控板横向手势交给浏览器。
          if (event.deltaX !== 0) return;
          const viewport = event.currentTarget;
          const unit =
            event.deltaMode === 1
              ? 16
              : event.deltaMode === 2
                ? viewport.clientWidth
                : 1;
          viewport.scrollBy({ left: event.deltaY * unit });
        }}
      >
        <TabsList className="mx-auto flex h-7 w-max justify-start gap-0.5 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-7">
          {TABS.map((tab) => (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              data-settings-tab={tab.id}
              className="h-7 flex-none gap-1.5 rounded-md bg-transparent px-2 text-xs duration-control ease-standard focus-visible:ring-0 focus-visible:outline-none data-active:bg-accent dark:data-active:bg-accent"
            >
              <HugeiconsIcon icon={tab.icon} size={12} strokeWidth={1.75} />
              <span>{t(`tabs.${tab.id}`)}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  );

  return (
    <AuxiliaryWindowLayout
      title={t("windowTitle")}
      headerContent={headerContent}
    >
      <main className="app-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-page">
        <div
          className={cn(
            "mx-auto flex w-full flex-1 flex-col",
            active === "remote" || active === "channels"
              ? "max-w-[58rem]"
              : "max-w-160",
          )}
        >
          {ActiveSection ? (
            <div key={active} className="terax-tab-in flex flex-1 flex-col">
              <Suspense
                fallback={
                  <p className="text-xs text-muted-foreground">
                    {t("channels:loading")}
                  </p>
                }
              >
                <ActiveSection />
              </Suspense>
            </div>
          ) : null}
        </div>
      </main>
    </AuxiliaryWindowLayout>
  );
}
