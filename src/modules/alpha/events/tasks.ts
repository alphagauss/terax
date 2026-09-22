/**
 * 本文件定义通用任务事件的前端校验与订阅入口。
 * 任务事件携带完整快照，调用方按 revision 覆盖并在终态后查询领域结果。
 */

import { alphaEventClient } from "@/modules/alpha/events/EventClient";
import type { AlphaEventEnvelope } from "@/modules/alpha/events/model";
import {
  taskSnapshotSchema,
  type AlphaTaskSnapshot,
} from "@/modules/alpha/events/taskModel";

/** 订阅全部任务或指定 task ID，并拒绝非法公共 payload。 */
export function subscribeAlphaTasks(
  listener: (task: AlphaTaskSnapshot) => void,
  taskId: string | null = null,
): () => void {
  return alphaEventClient.subscribe(
    { event: "task.updated", key: taskId },
    (event: AlphaEventEnvelope) => {
      const parsed = taskSnapshotSchema.safeParse(event.data);
      if (parsed.success) listener(parsed.data);
    },
  );
}

/** 订阅公共事件连接状态，用于重连后刷新 HTTP 权威快照。 */
export function subscribeAlphaEventConnection(
  listener: (connected: boolean) => void,
): () => void {
  return alphaEventClient.subscribeState((state) =>
    listener(state === "connected"),
  );
}

/** 把内部任务终态映射为现有页面使用的展示状态。 */
export function taskDisplayStatus(status: AlphaTaskSnapshot["status"]): string {
  if (status === "succeeded") return "completed";
  if (status === "timeout") return "failed";
  return status;
}
