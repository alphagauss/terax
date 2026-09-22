/** HTTP 与事件共用的任务快照校验，不依赖连接或订阅运行时。 */
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
