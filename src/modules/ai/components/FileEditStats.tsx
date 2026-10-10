/** 文件编辑统计共用入口，实时数字按调用订阅，历史数据来自消息的展示投影。 */
import { useChatDisplaySnapshot } from "@/modules/ai/hooks/chatDisplay";
import { Hint } from "@/components/controls/tooltip";
import { createContext, memo, useCallback, useContext } from "react";
import { useTranslation } from "react-i18next";
import {
  peekFileEditRuntime,
  subscribeFileEdits,
} from "@/modules/ai/lib/fileEditRuntime";
import type {
  FileEditCall,
  FileEditStats as Stats,
} from "@/modules/ai/lib/fileEdits";
import { AnimatedDiffStats } from "@/components/controls/animated-diff-stats";

export const FileEditContext = createContext<{
  sessionId: string;
  calls?: readonly FileEditCall[];
}>({ sessionId: "" });

/** 标题和工具行只关心当前调用，其他调用更新不会触发此组件重渲染。 */
export const FileEditStats = memo(function FileEditStats({
  toolCallId,
  taskId,
  className,
}: {
  toolCallId: string;
  taskId?: string;
  className?: string;
}) {
  const { sessionId, calls } = useContext(FileEditContext);
  const subscribe = useCallback(
    (listener: () => void) => subscribeFileEdits(sessionId, listener),
    [sessionId],
  );
  const getSnapshot = useCallback(
    // 历史调用 ID 可能被后续轮次复用，已保存的消息只读取自己的快照。
    () =>
      calls
        ? undefined
        : peekFileEditRuntime(sessionId)?.getCall(toolCallId, taskId),
    [sessionId, toolCallId, taskId, calls],
  );
  const live = useChatDisplaySnapshot(subscribe, getSnapshot);
  const value =
    live ??
    calls?.find(
      (call) => call.toolCallId === toolCallId && call.taskId === taskId,
    );
  const { t } = useTranslation("ai");
  if (!value) return null;
  if (value.uncertain)
    return (
      <span className={`shrink-0 text-xs text-destructive ${className ?? ""}`}>
        {t("chat.fileEdits.uncertain")}
      </span>
    );
  return (
    <span className={className}>
      <DiffStats
        stats={value}
        animate={Boolean(live)}
        approximate={live?.approximate}
      />
    </span>
  );
});

export function DiffStats({
  stats,
  animate = false,
  approximate = false,
}: {
  stats: Stats;
  animate?: boolean;
  approximate?: boolean;
}) {
  const { t } = useTranslation("ai");
  return (
    <Hint content={approximate ? t("chat.fileEdits.estimate") : undefined}>
      <AnimatedDiffStats stats={stats} animate={animate} />
    </Hint>
  );
}
