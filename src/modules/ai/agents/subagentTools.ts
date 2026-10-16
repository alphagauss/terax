/** 主 Agent 的子任务控制入口，按会话隔离查询、消息接入和恢复执行。 */

import { buildSubagentTaskRunner } from "@/modules/ai/agents/subagentRunner";
import {
  restoredSubagentResult,
  type SubagentSession,
  SubagentSessions,
} from "@/modules/ai/agents/subagentSession";
import type { RunAgentOptions } from "@/modules/ai/lib/agent";
import { native } from "@/modules/ai/lib/native";
import type { SubagentStarter } from "@/modules/ai/tools/subagent";
import { buildTools } from "@/modules/ai/tools/tools";

/** 延迟加载子会话，普通工具调用不读取额外历史。 */
export function buildManagedSubagentTools(opts: RunAgentOptions) {
  const coordinator = opts.turnCoordinator;
  const sessions = () =>
    coordinator.getSessions(
      opts.openSubagentSessions ??
        (() => Promise.resolve(new SubagentSessions())),
    );
  const accepting = coordinator.acceptingSubagents;
  const start = async (
    input: Parameters<SubagentStarter>[0],
    taskId?: string,
  ) => {
    const store = await sessions();
    return coordinator.start({
      ...input,
      taskId,
      existingTaskIds: store.tasks.keys(),
      limit: opts.maxConcurrentSubagents,
      parentAbortSignal: input.abortSignal,
      onDisplay: opts.onSubagentDisplay,
      run: buildSubagentTaskRunner({
        opts,
        permissionMode: opts.toolContext.getPermissionMode(),
        store,
        accepting,
      }),
    });
  };
  const rootTools = buildTools(
    opts.toolContext,
    opts.allowedTools,
    start,
    async (input, execution) => {
      const store = await sessions();
      const describe = (task: SubagentSession) => ({
        taskId: task.taskId,
        label: task.label,
        status: coordinator.isRunning(task.taskId) ? "running" : task.status,
        ...(task.error ? { error: task.error } : {}),
        pendingMessages: task.pending.length,
        currentTool: coordinator.isRunning(task.taskId)
          ? task.executions?.find(
              (entry) =>
                entry.status === "started" &&
                !task.executions?.some(
                  (other) =>
                    other.id === entry.id && other.status === "finished",
                ),
            )?.name
          : undefined,
      });
      if (input.action === "list")
        return {
          tasks: [...store.tasks.values()].map(describe),
          concurrency: { limit: opts.maxConcurrentSubagents, running: coordinator.runningCount },
        };
      const task = store.tasks.get(input.taskId ?? "");
      if (!task)
        return {
          status: "rejected",
          error: "Task not found in this chat.",
        };
      if (input.action === "wait") {
        // 在首次等待前捕获历史结果，避免并行续跑改变本次等待的执行归属。
        const restored = restoredSubagentResult(task);
        return (
          (await coordinator.wait(
            task.taskId,
            input.timeoutMs ?? 30000,
            execution.abortSignal ?? opts.abortSignal,
          )) ?? restored
        );
      }
      if (input.action === "get") {
        const history = (await store.history(task)).flatMap((message) => {
          if (
            message.role !== "user" &&
            message.role !== "assistant" &&
            message.role !== "tool"
          )
            return [];
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .flatMap((part) => {
                    if (part.type === "text") return [part.text];
                    if (
                      part.type === "tool-call" ||
                      part.type === "tool-result"
                    )
                      return [JSON.stringify(part)];
                    return [];
                  })
                  .join("\n");
          return text
            ? [
                {
                  role: message.role,
                  text: text.slice(0, 8000),
                  truncated: text.length > 8000,
                },
              ]
            : [];
        });
        const limit = input.limit ?? 10;
        const offset = input.offset ?? Math.max(0, history.length - limit);
        return {
          ...describe(task),
          offset,
          total: history.length,
          history: history.slice(offset, offset + limit),
        };
      }
      if (input.action === "stop") {
        accepting.delete(task.taskId);
        await coordinator.stop(task.taskId, () =>
          native.shellStopTask(opts.toolContext.getSessionId(), task.taskId),
        );
        return { ...describe(task), cleanup: "completed" };
      }
      if (task.status === "context_exhausted")
        return {
          status: "rejected",
          error:
            "Context exhausted. Read this task's results and create a new task with run_subagent.",
        };
      if (coordinator.isRunning(task.taskId)) {
        if (!accepting.has(task.taskId))
          return {
            status: "rejected",
            error: "Task is finishing. Retry after its result arrives.",
          };
        const queued = {
          id: crypto.randomUUID(),
          message: input.message ?? "",
        };
        // 先登记再等待落盘，执行边界会等待同一写入队列，避免终态竞争丢失消息。
        const ready = store.append(task, { queued });
        task.pending.push({ ...queued, ready });
        try {
          await ready;
        } catch (error) {
          task.pending = task.pending.filter((item) => item.id !== queued.id);
          throw error;
        }
        return {
          taskId: task.taskId,
          status: "queued",
          message: "Instructions queued for the next execution boundary.",
        };
      }
      return start(
        {
          task: input.message ?? "",
          label: task.label,
          wait: input.wait ?? false,
          ...execution,
        },
        task.taskId,
      );
    },
  );
  return rootTools;
}
