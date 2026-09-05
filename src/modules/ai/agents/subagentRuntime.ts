/**
 * 本文件协调单个聊天 turn 的消息接入与通用 Subagent 任务。
 * 负责统一接入队列、Subagent 并发拒绝、同步等待、取消和结构化展示进度。
 */

import type {
  SubagentDisplayState,
  SubagentDisplayStep,
} from "@/modules/ai/agents/subagentDisplay";
import { TurnInbox } from "@/modules/ai/lib/turnInbox";

export type SubagentUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type SubagentTaskResult = {
  taskId: string;
  label: string;
  status: "completed" | "failed";
  result?: string;
  error?: string;
  durationMs: number;
  usage: SubagentUsage;
};

export type SubagentStartResult =
  | {
      taskId: string;
      label: string;
      status: "running";
      message: string;
    }
  | SubagentTaskResult
  | {
      status: "rejected";
      error: string;
    };

export type SubagentTaskRunner = (options: {
  taskId: string;
  task: string;
  label: string;
  abortSignal: AbortSignal;
  onProgress: (event: SubagentProgressEvent) => void;
}) => Promise<Omit<SubagentTaskResult, "taskId" | "label" | "durationMs">>;

type SubagentProgressEvent =
  | { type: "thinking" }
  | {
      type: "tool-start";
      id: string;
      toolName: string;
      summary?: string;
    }
  | {
      type: "tool-finish";
      id: string;
      status: "completed" | "failed";
    };

type RunningTask = {
  order: number;
  controller: AbortController;
  done: Promise<SubagentTaskResult>;
  cancelDisplay: () => void;
};

const EMPTY_USAGE: SubagentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

const coordinators = new Map<string, AgentTurnCoordinator>();

/** 取得进程内按聊天隔离的协调器；运行锁保证同一聊天只有一个活动 turn。 */
export function getAgentTurnCoordinator(
  sessionId: string,
): AgentTurnCoordinator {
  const existing = coordinators.get(sessionId);
  if (existing) return existing;
  const created = new AgentTurnCoordinator();
  coordinators.set(sessionId, created);
  return created;
}

/** 正常 turn 结束后释放空闲协调器，避免历史聊天长期占用进程内映射。 */
export function releaseAgentTurnCoordinator(
  sessionId: string,
  coordinator: AgentTurnCoordinator,
): void {
  if (coordinators.get(sessionId) === coordinator && coordinator.isIdle) {
    coordinators.delete(sessionId);
  }
}

/** 取消并释放指定聊天的待接入输入和全部 Subagent 状态。 */
export async function clearAgentTurnCoordinator(
  sessionId: string,
): Promise<void> {
  const coordinator = coordinators.get(sessionId);
  if (!coordinator) return;
  coordinators.delete(sessionId);
  await coordinator.cancelAll();
}

/**
 * 单聊天运行协调器，持有当前轮输入和 Subagent 资源。
 *
 * 并发检查和任务登记在首次异步等待前完成，因此同一模型 step 并行调用工具时
 * 也不会突破上限。后台完成结果只追加到待消费队列，不改写既有工具结果。
 */
export class AgentTurnCoordinator {
  private readonly running = new Map<string, RunningTask>();
  readonly inbox = new TurnInbox();
  private order = 0;
  private cancelled = false;

  get runningCount(): number {
    return this.running.size;
  }

  get isIdle(): boolean {
    return this.running.size === 0 && !this.inbox.hasPending;
  }

  /** 启动一个同步等待或后台 Subagent，超过当前聊天额度时立即拒绝。 */
  async start(options: {
    task: string;
    label?: string;
    toolCallId: string;
    wait: boolean;
    limit: number;
    parentAbortSignal?: AbortSignal;
    run: SubagentTaskRunner;
    onDisplay?: (state: SubagentDisplayState) => void;
  }): Promise<SubagentStartResult> {
    if (this.cancelled) {
      return {
        status: "rejected",
        error: "Cannot start subagent: this turn is no longer active.",
      };
    }
    const running = this.running.size;
    if (running >= options.limit) {
      return {
        status: "rejected",
        error:
          `Cannot start subagent: concurrency limit reached ` +
          `(${running}/${options.limit} running). Wait for a running ` +
          `subagent to complete before starting another.`,
      };
    }

    const taskId = crypto.randomUUID();
    const label = normalizeLabel(options.label, options.task);
    const controller = new AbortController();
    const order = this.order++;
    const detachAbort = relayAbort(options.parentAbortSignal, controller);
    const startedAt = Date.now();
    let display: SubagentDisplayState = {
      taskId,
      toolCallId: options.toolCallId,
      label,
      status: "running",
      phase: "thinking",
      startedAt,
      steps: [],
    };
    const publishDisplay = () => {
      try {
        options.onDisplay?.(display);
      } catch {
        // 展示回调不能改变 Subagent 的执行结果或取消语义。
      }
    };
    const updateProgress = (event: SubagentProgressEvent) => {
      if (display.status !== "running") return;
      display = reduceDisplayProgress(display, event);
      publishDisplay();
    };
    const finishDisplay = (
      status: Exclude<SubagentDisplayState["status"], "running">,
      details: Partial<Pick<SubagentDisplayState, "result" | "error">> = {},
    ) => {
      const now = Date.now();
      if (display.status === "running") {
        display = {
          ...display,
          ...details,
          status,
          durationMs: now - startedAt,
          steps: closeRunningDisplaySteps(display.steps, status),
        };
        publishDisplay();
      }
      return now;
    };
    const cancelDisplay = () => finishDisplay("cancelled");
    publishDisplay();
    const done = options
      .run({
        taskId,
        task: options.task,
        label,
        abortSignal: controller.signal,
        onProgress: updateProgress,
      })
      .then((result): SubagentTaskResult => {
        const now = finishDisplay(result.status, {
          ...(options.wait || result.result === undefined
            ? {}
            : { result: result.result }),
          ...(result.error === undefined ? {} : { error: result.error }),
        });
        return {
          ...result,
          taskId,
          label,
          durationMs: now - startedAt,
        };
      })
      .catch((error): SubagentTaskResult => {
        const now = finishDisplay(
          controller.signal.aborted ? "cancelled" : "failed",
          { error: String(error) },
        );
        return {
          taskId,
          label,
          status: "failed",
          error: String(error),
          durationMs: now - startedAt,
          usage: EMPTY_USAGE,
        };
      })
      .finally(detachAbort);

    this.running.set(taskId, { order, controller, done, cancelDisplay });
    void done.then((result) => {
      this.running.delete(taskId);
      if (!options.wait && !this.cancelled) {
        this.inbox.push(
          {
            version: 1,
            event: "subagent_result",
            results: [
              {
                taskId: result.taskId,
                label: result.label,
                status: result.status,
                ...(result.result === undefined
                  ? {}
                  : { result: result.result }),
                ...(result.error === undefined ? {} : { error: result.error }),
              },
            ],
          },
          order,
        );
      }
    });

    if (!options.wait) {
      return {
        taskId,
        label,
        status: "running",
        message: `Subagent [${label}] started (id: ${taskId}). It will report back when complete.`,
      };
    }

    return await done;
  }

  /** 等待当前聊天已经登记的全部 Subagent 完成。 */
  async waitForAll(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()].map((task) => task.done));
    }
  }

  /** 取消本聊天的全部 Subagent，并丢弃尚未消费的用户输入和后台结果。 */
  async cancelAll(): Promise<void> {
    this.cancelled = true;
    this.inbox.cancel();
    const tasks = [...this.running.values()];
    for (const task of tasks) {
      task.cancelDisplay();
      task.controller.abort();
    }
    await Promise.all(tasks.map((task) => task.done));
    this.running.clear();
  }

  /** 在一个 turn 正常完成后清除临时序号，下一轮重新开始。 */
  reset(): void {
    if (this.running.size > 0 || this.inbox.hasPending) return;
    this.order = 0;
    this.cancelled = false;
  }
}

function reduceDisplayProgress(
  state: SubagentDisplayState,
  event: SubagentProgressEvent,
): SubagentDisplayState {
  if (event.type === "thinking") {
    return { ...state, phase: "thinking" };
  }
  if (event.type === "tool-start") {
    const step: SubagentDisplayStep = {
      id: event.id,
      toolName: event.toolName,
      ...(event.summary ? { summary: event.summary } : {}),
      status: "running",
    };
    const index = state.steps.findIndex((item) => item.id === event.id);
    return {
      ...state,
      phase: "tool",
      steps:
        index < 0
          ? [...state.steps, step]
          : state.steps.map((item, itemIndex) =>
              itemIndex === index ? step : item,
            ),
    };
  }
  const steps = state.steps.map((step) =>
    step.id === event.id
      ? {
          ...step,
          status: event.status,
        }
      : step,
  );
  return {
    ...state,
    phase: steps.some((step) => step.status === "running")
      ? "tool"
      : "thinking",
    steps,
  };
}

function closeRunningDisplaySteps(
  steps: readonly SubagentDisplayStep[],
  status: Exclude<SubagentDisplayStep["status"], "running">,
): SubagentDisplayStep[] {
  return steps.map((step) =>
    step.status === "running"
      ? {
          ...step,
          status,
        }
      : step,
  );
}

function normalizeLabel(label: string | undefined, task: string): string {
  const value = label?.trim() || task.trim();
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

function relayAbort(
  signal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}
