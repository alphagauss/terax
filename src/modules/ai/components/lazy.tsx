/**
 * 本文件为 AI 侧边栏、审批和选区入口提供按需加载边界。
 * 会话执行由独立运行时负责，界面仅按需加载。
 */

import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { ApprovalToastHostProps } from "./ApprovalToastHost";
import type { SelectionAskAiProps } from "./SelectionAskAi";

const AiSidebarPanelInner = lazy(() =>
  import("./AiSidebarPanel").then((m) => ({ default: m.AiSidebarPanel })),
);

const ApprovalToastHostInner = lazy(() =>
  import("./ApprovalToastHost").then((m) => ({
    default: m.ApprovalToastHost,
  })),
);

const SelectionAskAiInner = lazy(() =>
  import("./SelectionAskAi").then((m) => ({ default: m.SelectionAskAi })),
);

/** 按需加载持续工具审批通知。 */
export function ApprovalToastHost(props: ApprovalToastHostProps) {
  return (
    <Suspense fallback={null}>
      <ApprovalToastHostInner {...props} />
    </Suspense>
  );
}

/** 按需加载 AI 侧边栏内容。 */
export function AiSidebarPanel({
  hasComposer,
  visible,
}: {
  hasComposer: boolean;
  visible: boolean;
}) {
  const { t } = useTranslation("common");
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-sidebar text-xs text-muted-foreground">
          {t("loading")}
        </div>
      }
    >
      <AiSidebarPanelInner hasComposer={hasComposer} visible={visible} />
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
