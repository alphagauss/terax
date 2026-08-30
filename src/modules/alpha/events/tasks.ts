/**
 * 本文件定义通用任务事件的前端校验与订阅入口。
 * 任务事件携带完整快照，调用方按 revision 覆盖并在终态后查询领域结果。
 */

import { alphaEventClient } from "@/modules/alpha/events/EventClient";
import type { AlphaEventEnvelope } from "@/modules/alpha/events/model";
import { z } from "zod";

export const taskSnapshotSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  kind: z.string().min(1),
  name: z.string(),
  status: z.enum(["running", "succeeded", "failed", "cancelled", "timeout"]),
  stage: z.string().nullable(),
  progress: z
    .object({
      completed: z.number().nullable(),
      total: z.number().nullable(),
      unit: z.string().nullable(),
    })
    .nullable(),
  metrics: z.record(z.string(), z.unknown()),
  message: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});

export type AlphaTaskSnapshot = z.infer<typeof taskSnapshotSchema>;

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
