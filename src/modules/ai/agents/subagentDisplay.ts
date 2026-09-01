/**
 * 本文件定义 Subagent 的前端展示状态和持久化快照。
 * 展示数据只记录工具生命周期摘要，不包含推理正文、完整工具输出或模型上下文。
 */

import type { UIMessage } from "@ai-sdk/react";
import { redactSensitive } from "../lib/redact";

export type SubagentDisplayStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type SubagentDisplayStep = {
  id: string;
  toolName: string;
  summary?: string;
  status: SubagentDisplayStatus;
};

/** 当前进程中的完整展示状态，结果只用于实时 UI，不重复持久化。 */
export type SubagentDisplayState = {
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
  status: Exclude<SubagentDisplayStatus, "running">;
};

/** JSONL 中只服务历史展示的终态快照。 */
export type SubagentDisplaySnapshot = Pick<
  SubagentDisplayState,
  "taskId" | "toolCallId" | "label"
> & {
  version: 1;
  status: Exclude<SubagentDisplayStatus, "running">;
  durationMs: number;
  steps: SubagentDisplaySnapshotStep[];
};

type SubagentDisplayData = {
  snapshot: SubagentDisplaySnapshot;
};

const SUMMARY_LIMIT = 160;
const SNAPSHOT_KEYS = new Set([
  "version",
  "taskId",
  "toolCallId",
  "label",
  "status",
  "durationMs",
  "steps",
]);
const SNAPSHOT_STEP_KEYS = new Set(["id", "toolName", "summary", "status"]);

/**
 * 从工具输入提取适合聊天标题和过程列表的短摘要。
 *
 * 摘要经过敏感信息遮盖和长度限制，不保存文件正文或工具输出。
 */
export function summarizeSubagentToolInput(
  toolName: string,
  input: unknown,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const text = (key: string) =>
    typeof value[key] === "string" ? value[key] : undefined;
  let summary: string | undefined;

  switch (toolName) {
    case "read_file":
    case "write_file":
      summary = text("path");
      break;
    case "find_files":
      summary = [text("path") ?? ".", text("glob")].filter(Boolean).join(" ");
      break;
    case "grep":
      summary = [text("pattern") ?? text("query"), text("path")]
        .filter(Boolean)
        .join(" ");
      break;
    case "apply_patch": {
      const files = Array.isArray(value.files) ? value.files : [];
      const paths = files
        .map((file) =>
          file && typeof file === "object" && "path" in file
            ? String((file as { path?: unknown }).path ?? "")
            : "",
        )
        .filter(Boolean);
      summary = paths.join(", ") || undefined;
      break;
    }
    case "file_operation": {
      const operation = text("operation");
      const path = text("path");
      const destination = text("destination");
      summary = [operation, path, destination].filter(Boolean).join(" ");
      break;
    }
    case "shell_exec":
      summary = text("command");
      break;
    case "shell_process":
      summary = [text("action"), text("process_id")].filter(Boolean).join(" ");
      break;
    default:
      summary = undefined;
  }

  const normalized = redactSensitive(summary?.trim() ?? "");
  if (!normalized) return undefined;
  return normalized.length > SUMMARY_LIMIT
    ? `${normalized.slice(0, SUMMARY_LIMIT - 3)}...`
    : normalized;
}

/** 判断工具虽正常返回，但输出是否使用统一 error 字段表达业务失败。 */
export function isSubagentToolErrorOutput(output: unknown): boolean {
  return Boolean(
    output &&
      typeof output === "object" &&
      typeof (output as { error?: unknown }).error === "string",
  );
}

/** 将实时状态收敛为不重复 task 和结果正文的终态展示快照。 */
export function toSubagentDisplaySnapshot(
  state: SubagentDisplayState,
  interruptedStatus: "failed" | "cancelled",
  now = Date.now(),
): SubagentDisplaySnapshot {
  const status = state.status === "running" ? interruptedStatus : state.status;
  return {
    version: 1,
    taskId: state.taskId,
    toolCallId: state.toolCallId,
    label: state.label,
    status,
    durationMs: state.durationMs ?? Math.max(0, now - state.startedAt),
    steps: state.steps.map(
      (step): SubagentDisplaySnapshotStep => ({
        ...step,
        status:
          step.status === "running"
            ? status === "cancelled"
              ? "cancelled"
              : "failed"
            : step.status,
      }),
    ),
  };
}

/** 校验来自 JSONL 的 display-only Subagent 快照。 */
export function isSubagentDisplaySnapshot(
  value: unknown,
): value is SubagentDisplaySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  if (
    Object.keys(snapshot).some((key) => !SNAPSHOT_KEYS.has(key)) ||
    snapshot.version !== 1 ||
    !isBoundedText(snapshot.taskId, 128) ||
    !isBoundedText(snapshot.toolCallId, 256) ||
    !isBoundedText(snapshot.label, 60) ||
    !isTerminalStatus(snapshot.status) ||
    !isNonNegativeNumber(snapshot.durationMs) ||
    !Array.isArray(snapshot.steps) ||
    snapshot.steps.length > 200
  ) {
    return false;
  }
  return snapshot.steps.every(isDisplayStep);
}

/** 判断 AI SDK data part 是否为历史 Subagent 展示快照。 */
export function isSubagentDisplayDataPart(value: unknown): value is {
  type: "data-subagent-display";
  data: SubagentDisplayData;
} {
  if (!value || typeof value !== "object") return false;
  const part = value as { type?: unknown; data?: unknown };
  if (part.type !== "data-subagent-display" || !part.data) return false;
  return isSubagentDisplaySnapshot(
    (part.data as { snapshot?: unknown }).snapshot,
  );
}

/**
 * 把终态快照附加到拥有对应 run_subagent 工具调用的 UI 消息。
 *
 * 此操作只在本轮提交成功后执行，避免与 AI SDK 的活动流同时修改消息。
 */
export function materializeSubagentDisplayParts(
  messages: readonly UIMessage[],
  snapshots: readonly SubagentDisplaySnapshot[],
): UIMessage[] {
  if (snapshots.length === 0) return [...messages];
  const byToolCallId = new Map(
    snapshots.map((snapshot) => [snapshot.toolCallId, snapshot]),
  );
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "assistant") return message;
    const owned = message.parts
      .filter(
        (part) =>
          part.type === "tool-run_subagent" ||
          (part.type === "dynamic-tool" &&
            "toolName" in part &&
            part.toolName === "run_subagent"),
      )
      .map((part) =>
        "toolCallId" in part && typeof part.toolCallId === "string"
          ? part.toolCallId
          : null,
      )
      .filter((toolCallId): toolCallId is string => toolCallId !== null)
      .map((toolCallId) => byToolCallId.get(toolCallId))
      .filter((snapshot): snapshot is SubagentDisplaySnapshot => !!snapshot)
      .filter(
        (snapshot, index, values) =>
          values.findIndex((item) => item.taskId === snapshot.taskId) === index,
      );
    if (owned.length === 0) return message;
    const ownedIds = new Set(owned.map((snapshot) => snapshot.taskId));
    changed = true;
    return {
      ...message,
      parts: [
        ...message.parts.filter(
          (part) =>
            !isSubagentDisplayDataPart(part) ||
            !ownedIds.has(part.data.snapshot.taskId),
        ),
        ...owned.map(
          (snapshot) =>
            ({
              type: "data-subagent-display",
              data: { snapshot },
            }) as UIMessage["parts"][number],
        ),
      ],
    };
  });
  return changed ? next : [...messages];
}

function isTerminalStatus(
  value: unknown,
): value is Exclude<SubagentDisplayStatus, "running"> {
  return value === "completed" || value === "failed" || value === "cancelled";
}

function isDisplayStep(value: unknown): value is SubagentDisplaySnapshotStep {
  if (!value || typeof value !== "object") return false;
  const step = value as Record<string, unknown>;
  return (
    !Object.keys(step).some((key) => !SNAPSHOT_STEP_KEYS.has(key)) &&
    isBoundedText(step.id, 256) &&
    isBoundedText(step.toolName, 128) &&
    (step.summary === undefined ||
      (typeof step.summary === "string" &&
        step.summary.length <= SUMMARY_LIMIT)) &&
    (step.status === "completed" ||
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
