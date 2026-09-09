/** 文件编辑统计共用入口，实时数字按调用订阅，历史数据来自消息的展示投影。 */
import { Hint } from "@/components/controls/tooltip";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  peekFileEditRuntime,
  subscribeFileEdits,
} from "@/modules/ai/lib/fileEditRuntime";
import type {
  FileEditCall,
  FileEditStats as Stats,
} from "@/modules/ai/lib/fileEdits";
import "./FileEditStats.css";

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
  const live = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
      <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
        <RollingNumber
          value={stats.added}
          direction="up"
          prefix="+"
          animate={animate}
        />
        <RollingNumber
          value={stats.removed}
          direction="down"
          prefix="-"
          animate={animate}
        />
      </span>
    </Hint>
  );
}

function RollingNumber({
  value,
  direction,
  prefix,
  animate,
}: {
  value: number;
  direction: "up" | "down";
  prefix: string;
  animate: boolean;
}) {
  const [pair, setPair] = useState({ previous: value, current: value });
  if (pair.current !== value)
    setPair({ previous: pair.current, current: value });
  const moving = animate && pair.previous !== pair.current;
  return (
    <span
      className={`file-edit-number ${direction === "up" ? "text-success" : "text-destructive"}`}
      data-direction={direction}
    >
      <span
        key={value}
        className={moving ? "file-edit-number-motion" : undefined}
      >
        {moving && (
          <span aria-hidden className="file-edit-number-old">
            {prefix}
            {pair.previous}
          </span>
        )}
        <span className="file-edit-number-new">
          {prefix}
          {value}
        </span>
      </span>
    </span>
  );
}
