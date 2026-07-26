/**
 * 本文件为 AI 侧边栏、运行桥和选区入口提供按需加载边界。
 * 后台运行桥保持独立，关闭或移动侧边栏不会中断会话。
 */

import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { AgentRunBridgeProps } from "./AgentRunBridge";
import type { SelectionAskAiProps } from "./SelectionAskAi";

const AgentRunBridgeInner = lazy(() =>
  import("./AgentRunBridge").then((m) => ({ default: m.AgentRunBridge })),
);

const AiSidebarPanelInner = lazy(() =>
  import("./AiSidebarPanel").then((m) => ({ default: m.AiSidebarPanel })),
);

const SelectionAskAiInner = lazy(() =>
  import("./SelectionAskAi").then((m) => ({ default: m.SelectionAskAi })),
);

export function AgentRunBridge(props: AgentRunBridgeProps) {
  return (
    <Suspense fallback={null}>
      <AgentRunBridgeInner {...props} />
    </Suspense>
  );
}

/** 按需加载 AI 侧边栏内容。 */
export function AiSidebarPanel({ hasComposer }: { hasComposer: boolean }) {
  const { t } = useTranslation("common");
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-sidebar text-xs text-muted-foreground">
          {t("loading")}
        </div>
      }
    >
      <AiSidebarPanelInner hasComposer={hasComposer} />
    </Suspense>
  );
}

export function SelectionAskAi(props: SelectionAskAiProps) {
  return (
    <Suspense fallback={null}>
      <SelectionAskAiInner {...props} />
    </Suspense>
  );
}
