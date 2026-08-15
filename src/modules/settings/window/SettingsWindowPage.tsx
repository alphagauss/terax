/**
 * 本文件实现设置辅助窗口的标签导航与内容布局。
 * 页面复用公共辅助窗口外壳，只持有设置分区选择，不管理原生窗口生命周期。
 */

import {
  AUXILIARY_OPEN_EVENT,
  type AuxiliaryWindowOpenRequest,
} from "@/auxiliary/openAuxiliaryWindow";
import { AuxiliaryWindowLayout } from "@/auxiliary/AuxiliaryWindowLayout";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
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
import {
  AiScanIcon,
  InformationCircleIcon,
  KeyboardIcon,
  PaintBoardIcon,
  ServerStack03Icon,
  Settings01Icon,
  SourceCodeIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type JSX, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const TABS: {
  id: SettingsTab;
  icon: typeof Settings01Icon;
  component: () => JSX.Element;
}[] = [
  { id: "general", icon: Settings01Icon, component: GeneralSection },
  { id: "editor", icon: SourceCodeIcon, component: EditorSection },
  { id: "themes", icon: PaintBoardIcon, component: ThemesSection },
  { id: "shortcuts", icon: KeyboardIcon, component: ShortcutsSection },
  { id: "models", icon: AiScanIcon, component: ModelsSection },
  { id: "agents", icon: UserMultiple02Icon, component: AgentsSection },
  { id: "remote", icon: ServerStack03Icon, component: RemoteSection },
  { id: "about", icon: InformationCircleIcon, component: AboutSection },
];

/** 从原生层验证过的初始 URL 中读取设置分区。 */
function readInitialTab(): SettingsTab {
  if (typeof window === "undefined") return "general";
  const tab = new URL(window.location.href).searchParams.get("tab");
  return isSettingsTab(tab) ? tab : "general";
}

/** 渲染设置辅助窗口，并响应统一窗口事件中的设置分区请求。 */
export function SettingsWindowPage() {
  const { t } = useTranslation("settings");
  const [active, setActive] = useState<SettingsTab>(readInitialTab);
  const init = usePreferencesStore((state) => state.init);
  const ActiveSection = TABS.find((tab) => tab.id === active)?.component;

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const unlistenPromise =
      getCurrentWebviewWindow().listen<AuxiliaryWindowOpenRequest>(
        AUXILIARY_OPEN_EVENT,
        (event) => {
          if (
            event.payload.kind === "settings" &&
            isSettingsTab(event.payload.tab)
          ) {
            setActive(event.payload.tab);
          }
        },
      );
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const headerContent = (
    <Tabs
      value={active}
      onValueChange={(value) => setActive(value as SettingsTab)}
      orientation="horizontal"
      className="flex min-w-0 flex-1 items-center"
      data-tauri-drag-region
    >
      <TabsList className="mx-auto h-7 max-w-full overflow-x-auto bg-muted/40 px-2">
        {TABS.map((tab) => (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            className="h-6 gap-1.5 px-2.5 text-[11.5px]"
          >
            <HugeiconsIcon icon={tab.icon} size={12} strokeWidth={1.75} />
            <span>{t(`tabs.${tab.id}`)}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );

  return (
    <AuxiliaryWindowLayout
      title={t("windowTitle")}
      headerContent={headerContent}
    >
      <main className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-7 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div
          className={cn(
            "mx-auto w-full",
            active === "remote" ? "max-w-[58rem]" : "max-w-160",
          )}
        >
          {ActiveSection ? (
            <div key={active} className="terax-tab-in">
              <ActiveSection />
            </div>
          ) : null}
        </div>
      </main>
    </AuxiliaryWindowLayout>
  );
}
