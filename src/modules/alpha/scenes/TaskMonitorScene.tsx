/** 任务观察场景，打开和重连读取快照，隐藏仅解除展示订阅，不取消任务。 */
import { getAlphaTasks } from "@/modules/alpha/api";
import {
  subscribeAlphaEventConnection,
  subscribeAlphaTasks,
} from "@/modules/alpha/events/tasks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

const taskKey = ["alpha", "tasks"] as const;

export function TaskMonitorScene({ visible }: { visible: boolean }) {
  const { t } = useTranslation("alpha");
  const client = useQueryClient();
  const query = useQuery({
    queryKey: taskKey,
    queryFn: getAlphaTasks,
    enabled: visible,
    staleTime: 0,
  });
  useEffect(() => {
    if (!visible) return;
    const refresh = () => {
      void client.invalidateQueries({ queryKey: taskKey });
    };
    // 多任务进度可能集中到达，合并通知后读取快照，避免每条事件都取消并重发请求。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = subscribeAlphaTasks(() => {
      timer ??= setTimeout(() => {
        timer = undefined;
        refresh();
      }, 250);
    });
    const disconnect = subscribeAlphaEventConnection((connected) => {
      if (connected) refresh();
    });
    return () => {
      clearTimeout(timer);
      release();
      disconnect();
    };
  }, [client, visible]);
  return (
    <div className="space-y-2 p-3 text-xs">
      <p className="text-muted-foreground">{t("desk.tasksDescription")}</p>
      {query.error && (
        <p role="alert" className="text-destructive">
          {String(query.error)}
        </p>
      )}
      {query.isPending ? (
        <p>{t("common.loading")}</p>
      ) : !query.data?.length && !query.error ? (
        <p>{t("desk.noTasks")}</p>
      ) : null}
      {query.data?.map((task) => (
        <div key={task.task_id} className="space-y-1 border-b py-2">
          <p className="break-words font-medium">{task.name}</p>
          <p>{t(`desk.taskStatus.${task.status}`)}</p>
          {task.stage && (
            <p className="text-muted-foreground">
              {t(`taskStages.${task.stage}`, { defaultValue: task.stage })}
            </p>
          )}
          {task.progress?.total != null && task.progress.total > 0 && (
            <progress
              className="w-full"
              aria-label={task.name}
              max={task.progress.total}
              value={task.progress.completed ?? 0}
            />
          )}
          {task.message && (
            <p className="break-words text-muted-foreground">{task.message}</p>
          )}
        </div>
      ))}
    </div>
  );
}
