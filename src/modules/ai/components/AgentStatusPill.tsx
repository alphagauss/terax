/**
 * 本文件渲染状态栏中的 AI 面板入口和聚合运行提示。
 * 入口不展示具体会话步骤，任一会话持有运行锁时仅显示橙色状态点。
 */

import { Hint } from "@/components/controls/tooltip";
import { cn } from "@/lib/utils";
import { AiChat01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "../store/chatStore";

type Props = {
  onClick: () => void;
  active?: boolean;
};

/** 提供 AI 侧栏开关，并以单一指示灯汇总所有会话的运行状态。 */
export function AgentStatusPill({ onClick, active = false }: Props) {
  const { t } = useTranslation("ai");
  const hasRunningSession = useChatStore(
    (state) => Object.keys(state.runLockSessionIds).length > 0,
  );
  const label = active
    ? hasRunningSession
      ? t("statusPill.closeAiSidebarRunning")
      : t("statusPill.closeAiSidebar")
    : hasRunningSession
      ? t("statusPill.openAiSidebarRunning")
      : t("statusPill.openAiSidebar");

  return (
    <Hint content={label}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors",
          "border-transparent text-muted-foreground hover:border-border/60 hover:bg-accent hover:text-foreground",
          active && "border-border bg-accent text-foreground",
        )}
        aria-label={label}
        aria-pressed={active}
      >
        {hasRunningSession ? (
          <span className="size-1.5 shrink-0 rounded-full bg-warning" />
        ) : null}
        <HugeiconsIcon icon={AiChat01Icon} size={12} strokeWidth={1.75} />
        <span>AI</span>
      </button>
    </Hint>
  );
}
