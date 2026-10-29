/**
 * 本文件定义 Subagent 的前端展示状态和派生快照。
 * 展示数据从子会话执行事实派生，不包含推理正文或完整模型上下文，不单独持久化。
 */

import { isToolSummary, type ToolSummary } from "@/modules/ai/lib/toolSummary";

export type SubagentDisplayStatus =
  | "running"
  | "stopping"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

export type SubagentDisplayStep = {
  id: string;
  toolName: string;
  summary?: ToolSummary;
  status: SubagentDisplayStatus;
};

/** 当前进程中的完整展示状态，结果只用于实时 UI，不重复持久化。 */
export type SubagentDisplayState = {
  runId?: string;
  parentTurnId?: string;
  instructions?: string[];
  taskId: string;
  toolCallId: string;
  label: string;
  status: SubagentDisplayStatus;
  phase: "thinking" | "tool";
  startedAt: number;
  durationMs?: number;
  steps: SubagentDisplayStep[];
  result?: string;
  error?: string;
};

type SubagentDisplaySnapshotStep = Omit<SubagentDisplayStep, "status"> & {
  status: Exclude<SubagentDisplayStatus, "running" | "stopping">;
};

/** 从子会话事实派生、只服务历史展示的终态快照。 */
export type SubagentDisplaySnapshot = Pick<
  SubagentDisplayState,
  "taskId" | "toolCallId" | "label" | "runId" | "parentTurnId" | "instructions"
> & {
  result?: string;
  error?: string;
  version: 2;
  status: Exclude<SubagentDisplayStatus, "running" | "stopping">;
  durationMs: number;
  steps: SubagentDisplaySnapshotStep[];
};

const SNAPSHOT_KEYS = new Set([
  "runId",
  "parentTurnId",
  "instructions",
  "result",
  "error",
  "version",
  "taskId",
  "toolCallId",
  "label",
  "status",
  "durationMs",
  "steps",
]);
const SNAPSHOT_STEP_KEYS = new Set(["id", "toolName", "summary", "status"]);

/** 判断工具虽正常返回，但输出是否使用统一 error 字段表达业务失败。 */
export function isSubagentToolErrorOutput(output: unknown): boolean {
  return Boolean(
    output &&
      typeof output === "object" &&
      typeof (output as { error?: unknown }).error === "string",
  );
}

/** 将实时状态收敛为内存展示快照，结果正文不另行持久化。 */
export function toSubagentDisplaySnapshot(
  state: SubagentDisplayState,
  interruptedStatus: "failed" | "cancelled",
  now = Date.now(),
): SubagentDisplaySnapshot {
  const status =
    state.status === "running" || state.status === "stopping"
      ? interruptedStatus
      : state.status;
  return {
    ...(state.runId ? { runId: state.runId } : {}),
    ...(state.parentTurnId ? { parentTurnId: state.parentTurnId } : {}),
    ...(state.instructions ? { instructions: state.instructions } : {}),
    ...(state.result === undefined ? {} : { result: state.result }),
    ...(state.error === undefined ? {} : { error: state.error }),
    version: 2,
    taskId: state.taskId,
    toolCallId: state.toolCallId,
    label: state.label,
    status,
    durationMs: state.durationMs ?? Math.max(0, now - state.startedAt),
    steps: state.steps.map(
      (step): SubagentDisplaySnapshotStep => ({
        ...step,
        status:
          step.status === "running" || step.status === "stopping"
            ? status === "cancelled"
              ? "cancelled"
              : "failed"
            : step.status,
      }),
    ),
  };
}

/** 校验内存中的 Subagent 展示快照。 */
export function isSubagentDisplaySnapshot(
  value: unknown,
): value is SubagentDisplaySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  if (
    Object.keys(snapshot).some((key) => !SNAPSHOT_KEYS.has(key)) ||
    snapshot.version !== 2 ||
    (snapshot.runId !== undefined && !isBoundedText(snapshot.runId, 128)) ||
    (snapshot.parentTurnId !== undefined &&
      !isBoundedText(snapshot.parentTurnId, 128)) ||
    (snapshot.instructions !== undefined &&
      (!Array.isArray(snapshot.instructions) ||
        !snapshot.instructions.every((item) => typeof item === "string"))) ||
    (snapshot.result !== undefined && typeof snapshot.result !== "string") ||
    (snapshot.error !== undefined && typeof snapshot.error !== "string") ||
    !isBoundedText(snapshot.taskId, 128) ||
    !isBoundedText(snapshot.toolCallId, 256) ||
    !isBoundedText(snapshot.label, 60) ||
    !isTerminalStatus(snapshot.status) ||
    !isNonNegativeNumber(snapshot.durationMs) ||
    !Array.isArray(snapshot.steps)
  ) {
    return false;
  }
  return snapshot.steps.every(isDisplayStep);
}

function isTerminalStatus(
  value: unknown,
): value is Exclude<SubagentDisplayStatus, "running" | "stopping"> {
  return (
    value === "completed" ||
    value === "incomplete" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isDisplayStep(value: unknown): value is SubagentDisplaySnapshotStep {
  if (!value || typeof value !== "object") return false;
  const step = value as Record<string, unknown>;
  return (
    !Object.keys(step).some((key) => !SNAPSHOT_STEP_KEYS.has(key)) &&
    isBoundedText(step.id, 256) &&
    isBoundedText(step.toolName, 128) &&
    (step.summary === undefined || isToolSummary(step.summary)) &&
    (step.status === "completed" ||
      step.status === "incomplete" ||
      step.status === "failed" ||
      step.status === "cancelled")
  );
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}
