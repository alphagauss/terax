/** 子会话执行单步循环，在工具边界保存事实并接入补充要求；不执行上下文压缩。 */

import { isSubagentToolErrorOutput } from "@/modules/ai/agents/subagentDisplay";
import type { SubagentTaskRunner } from "@/modules/ai/agents/subagentRuntime";
import type {
  SubagentSession,
  SubagentSessions,
} from "@/modules/ai/agents/subagentSession";
import { unfinishedToolResults } from "@/modules/ai/agents/subagentSession";
import {
  clampAgentSteps,
  getModelContextWindow,
  MAX_SUBAGENT_STEPS_DEFAULT,
  resolveModel,
} from "@/modules/ai/config";
import type {
  RunAgentOptions,
  SubagentModelConfiguration,
} from "@/modules/ai/lib/agent";
import { resolveSubagentTools } from "@/modules/ai/lib/agentTools";
import { createContextUsage } from "@/modules/ai/lib/contextUsage";
import { serializeSessionMessages } from "@/modules/ai/lib/conversation";
import { reportInvalidToolInput } from "@/modules/ai/lib/errors";
import { peekFileEditRuntime } from "@/modules/ai/lib/fileEditRuntime";
import { buildParameterOptions } from "@/modules/ai/lib/modelParameters";
import { ShellExecution } from "@/modules/ai/lib/shellExecution";
import { prepareAgentPrompt } from "@/modules/ai/lib/prompt";
import {
  buildConfiguredLanguageModel,
  createProviderDownload,
} from "@/modules/ai/lib/providerRuntime";
import { describeToolCall } from "@/modules/ai/lib/toolSummary";
import SUBAGENT_PROMPT from "@/modules/ai/prompts/subagent";
import { getProvider } from "@/modules/ai/providerRegistry";
import { buildToolApproval } from "@/modules/ai/tools/approval";
import { buildTools, type ToolContext } from "@/modules/ai/tools/tools";
import {
  createUIMessageStream,
  isStepCount,
  readUIMessageStream,
  streamText,
  type ToolSet,
  toUIMessageChunk,
  type UIMessage,
} from "ai";

const SUBAGENT_STEP_LIMIT_ERROR =
  "Subagent reached its step limit before completing the task.";
const SUBAGENT_STEP_LIMIT_SUMMARY_PROMPT = `Stop using tools: you have reached the step limit. Using only the task, conversation, and results already available, give a concise partial report of completed work, confirmed findings and evidence, unresolved items, and recommended next steps. Clearly state that the task is incomplete; do not claim full completion.`;
/** 按启动时权限快照创建一个不含递归能力的 Subagent runner。 */
export function buildSubagentTaskRunner({
  opts,
  permissionMode,
  store,
  accepting,
}: {
  store: SubagentSessions;
  accepting: Set<string>;
  opts: RunAgentOptions;
  permissionMode: "ask" | "full-access";
}): SubagentTaskRunner {
  const maxSubagentSteps = clampAgentSteps(
    opts.maxSubagentSteps ?? MAX_SUBAGENT_STEPS_DEFAULT,
    MAX_SUBAGENT_STEPS_DEFAULT,
  );
  const allowedTools = resolveSubagentTools(opts.allowedTools, permissionMode);
  const toolContext: ToolContext = {
    ...opts.toolContext,
    getPermissionMode: () => permissionMode,
    // Subagent 没有独立审批通道，越界调用应由原生边界返回明确错误。
    supportsApprovals: false,
  };
  return async ({
    taskId,
    toolCallId,
    task,
    label,
    abortSignal,
    onProgress,
  }) => {
    const shellExecution = new ShellExecution(
      opts.toolContext.getSessionId(),
      abortSignal,
      taskId,
    );
    const session: SubagentSession = store.tasks.get(taskId) ?? {
      taskId,
      runId: "",
      label,
      records: [],
      status: "running" as const,
      pending: [],
    };
    const toolExecutions = new Set<Promise<unknown>>();
    const settleTools = async () => {
      while (toolExecutions.size) await Promise.allSettled([...toolExecutions]);
    };
    const interruptedExecutions =
      session.status === "interrupted" ||
      session.status === "cancelled" ||
      session.status === "failed"
        ? (session.executions ?? [])
        : [];
    session.runId = shellExecution.id;
    onProgress({
      type: "execution",
      runId: session.runId,
      parentTurnId: opts.turnId,
      task,
    });
    session.executions = [];
    store.tasks.set(taskId, session);
    accepting.add(taskId);
    const record = (
      records: import("@/modules/ai/lib/conversation").SessionMessage[],
    ) => store.append(session, { records });
    const userRecord = (
      content: string,
    ): import("@/modules/ai/lib/conversation").SessionMessage => ({
      role: "user",
      content,
      turn_id: session.runId,
      timestamp: new Date().toISOString(),
    });
    const cleanup = async () => {
      try {
        await shellExecution.close();
      } catch (error) {
        await store.append(session, { status: "failed", error: String(error) });
        throw error;
      } finally {
        await settleTools();
        peekFileEditRuntime(opts.toolContext.getSessionId())?.finishTask(
          taskId,
        );
        accepting.delete(taskId);
        const pending = session.pending.splice(0);
        if (pending.length)
          await store.append(session, {
            consumed: pending.map((item) => item.id),
          });
      }
    };
    try {
      // 通过并发检查后的每次任务启动读取一次；首次 await 前冻结，后续步骤保持不变。
      const config: SubagentModelConfiguration = structuredClone(
        opts.getSubagentConfiguration?.(opts.model) ?? {
          model: opts.model,
          keys: opts.keys,
          providerBaseURLs: opts.providerBaseURLs,
          providerModels: opts.providerModels,
          customProviders: opts.customProviders,
          providerInstanceKeys: opts.providerInstanceKeys,
        },
      );
      const recovery = unfinishedToolResults(await store.history(session));
      await store.append(session, {
        status: "running",
        toolCallId,
        ...(session.systemPrompt === undefined
          ? { systemPrompt: `${opts.systemPrompt}\n\n${SUBAGENT_PROMPT}` }
          : {}),
        records: [
          ...(recovery.length
            ? [
                {
                  role: "model" as const,
                  content: recovery,
                  turn_id: session.runId,
                  timestamp: new Date().toISOString(),
                },
              ]
            : []),
          ...(interruptedExecutions.length
            ? [
                userRecord(
                  `Previous execution was interrupted. These tool execution facts may include operations whose outcome is unknown. Inspect current state before retrying any side effect.\n${JSON.stringify(interruptedExecutions)}`,
                ),
              ]
            : []),
          userRecord(task),
        ],
      });
      const model = config.model;
      const childModel = await buildConfiguredLanguageModel(
        model,
        config.keys,
        {
          providerBaseURLs: config.providerBaseURLs,
          customProviders: config.customProviders,
          providerInstanceKeys: config.providerInstanceKeys,
        },
      );
      const provider = resolveModel(model, {
        customProviders: config.customProviders,
        providerBaseURLs: config.providerBaseURLs,
      }).provider;
      let lastChildMessages = await store.history(session);
      const prompt = prepareAgentPrompt(
        session.systemPrompt ?? "",
        [],
        provider,
      );
      const tools: ToolSet = buildTools(
        {
          ...toolContext,
          shellExecution,
          fileEditTaskId: taskId,
          onFileEditInput: (id, toolName, input) => {
            onProgress({
              type: "tool-start",
              id,
              toolName,
              summary: describeToolCall(toolName, input, false),
            });
          },
        },
        allowedTools,
      );
      let journalError: unknown;
      const persistExecution = async (
        execution: NonNullable<
          import("@/modules/ai/agents/subagentSession").SubagentRecord["execution"]
        >,
      ) => {
        if (journalError) throw journalError;
        try {
          await store.append(session, { execution });
        } catch (error) {
          journalError = error;
          throw error;
        }
      };
      for (const [name, definition] of Object.entries(tools)) {
        const execute = definition.execute;
        if (!execute) continue;
        definition.execute = (input, execution) => {
          const pending = (async () => {
            await persistExecution({
              id: execution.toolCallId,
              name,
              input,
              status: "started",
            });
            if (journalError) throw journalError;
            abortSignal.throwIfAborted();
            try {
              const output = await execute(input, execution);
              await persistExecution({
                id: execution.toolCallId,
                name,
                output: { type: "tool-result", output },
                status: "finished",
              });
              return output;
            } catch (error) {
              if (!journalError)
                await persistExecution({
                  id: execution.toolCallId,
                  name,
                  output: { type: "tool-error", error: String(error) },
                  status: "finished",
                });
              throw error;
            }
          })();
          toolExecutions.add(pending);
          void pending.then(
            () => toolExecutions.delete(pending),
            () => toolExecutions.delete(pending),
          );
          return pending;
        };
      }
      const contextUsage = await createContextUsage({
        sessionId: opts.toolContext.getSessionId(),
        turnId: opts.turnId,
        taskId,
        runId: session.runId,
        model,
        contextWindow: getModelContextWindow(
          model,
          config.providerModels ?? {},
        ),
        instructions: prompt.instructions,
        tools,
      });
      let steps = 0;
      while (true) {
        abortSignal.throwIfAborted();
        const pending = session.pending.splice(0);
        if (pending.length) {
          await Promise.all(pending.map((item) => item.ready));
          abortSignal.throwIfAborted();
          await store.append(session, {
            consumed: pending.map((item) => item.id),
            records: pending.map((item) => userRecord(item.message)),
          });
          onProgress({
            type: "instructions",
            messages: pending.map((item) => item.message),
          });
          lastChildMessages.push(
            ...pending.map((item) => ({
              role: "user" as const,
              content: [{ type: "text" as const, text: item.message }],
            })),
          );
        }
        const summarizing = steps >= maxSubagentSteps;
        if (summarizing) {
          await record([userRecord(SUBAGENT_STEP_LIMIT_SUMMARY_PROMPT)]);
          lastChildMessages.push({
            role: "user",
            content: [
              { type: "text", text: SUBAGENT_STEP_LIMIT_SUMMARY_PROMPT },
            ],
          });
        }
        // 总结仍发送相同工具定义以保持缓存前缀，但不能执行任何工具或输入回调。
        const requestTools = summarizing
          ? Object.fromEntries(
              Object.entries(tools).map(([name, definition]) => {
                const {
                  execute: _execute,
                  onInputStart: _start,
                  onInputDelta: _delta,
                  onInputAvailable: _available,
                  ...schema
                } = definition;
                return [name, schema];
              }),
            )
          : tools;
        const result = streamText({
          repairToolCall: reportInvalidToolInput,
          ...buildParameterOptions(
            config.modelParameters ?? [],
            getProvider(provider).runtime.adapter,
            provider,
          ),
          prepareStep: ({ messages }) => {
            return contextUsage.prepareStep({
              messages: prepareAgentPrompt("", messages, provider).messages,
            });
          },
          model: childModel,
          experimental_download: createProviderDownload(
            model.providerId,
            abortSignal,
          ),
          instructions: prompt.instructions,
          messages: lastChildMessages,
          tools: requestTools,
          toolApproval: buildToolApproval(toolContext),
          stopWhen: isStepCount(1),
          abortSignal,
          onStepStart: () => {
            onProgress({ type: "thinking" });
          },
          onToolExecutionStart: ({ toolCall }) => {
            onProgress({
              type: "tool-start",
              id: toolCall.toolCallId,
              toolName: toolCall.toolName,
              summary: describeToolCall(toolCall.toolName, toolCall.input),
            });
          },
          onToolExecutionEnd: ({ toolCall, toolOutput }) => {
            onProgress({
              type: "tool-finish",
              id: toolCall.toolCallId,
              status:
                toolOutput.type === "tool-result" &&
                !isSubagentToolErrorOutput(toolOutput.output)
                  ? "completed"
                  : "failed",
            });
          },
          onLanguageModelCallEnd: (event) =>
            contextUsage.finish(event.usage, event.content, event.performance),
        });
        let partialMessage: UIMessage | undefined;
        let stepPersisted = false;
        try {
          let streamError: unknown;
          const uiStream = createUIMessageStream<UIMessage>({
            onError: (error) => {
              streamError = error;
              return String(error);
            },
            execute: async ({ writer }) => {
              for await (const chunk of result.stream) {
                contextUsage.observe(chunk);
                const uiChunk = toUIMessageChunk(chunk, {
                  tools,
                  sendStart: true,
                  sendFinish: true,
                  onError: String,
                });
                if (uiChunk) writer.write(uiChunk);
                if (chunk.type === "error") throw chunk.error;
                if (
                  chunk.type === "tool-error" ||
                  chunk.type === "tool-output-denied"
                ) {
                  peekFileEditRuntime(opts.toolContext.getSessionId())?.fail(
                    chunk.toolCallId,
                    taskId,
                  );
                  onProgress({
                    type: "tool-finish",
                    id: chunk.toolCallId,
                    status: "failed",
                  });
                }
              }
            },
          });
          for await (const message of readUIMessageStream({ stream: uiStream }))
            partialMessage = message;
          if (streamError) throw streamError;
          if (journalError) throw journalError;
          const [text, finishReason, responseMessages] = await Promise.all([
            result.text,
            result.finishReason,
            result.responseMessages,
          ]);
          await record([
            {
              role: "model",
              call_id: contextUsage.callId,
              content: responseMessages,
              turn_id: session.runId,
              timestamp: new Date().toISOString(),
            },
          ]);
          stepPersisted = true;
          abortSignal.throwIfAborted();
          lastChildMessages = [...lastChildMessages, ...responseMessages];
          steps++;
          if (summarizing) {
            await store.append(session, {
              status: "incomplete",
              error: SUBAGENT_STEP_LIMIT_ERROR,
            });
            return {
              status: "incomplete",
              ...(text ? { result: text } : {}),
              error: SUBAGENT_STEP_LIMIT_ERROR,
            };
          }
          if (finishReason === "tool-calls" || session.pending.length) {
            if (steps >= maxSubagentSteps) accepting.delete(taskId);
            continue;
          }
          accepting.delete(taskId);
          await store.append(session, { status: "completed" });
          return {
            status: "completed",
            result:
              text || "Task completed but no final response was generated.",
          };
        } catch (error) {
          if (!stepPersisted && partialMessage?.parts.length)
            await record(
              serializeSessionMessages([partialMessage], {
                timestamp: new Date().toISOString(),
                turnId: session.runId,
                turnStatus: abortSignal.aborted ? "cancelled" : "failed",
              }).map((entry) =>
                entry.role === "model" || entry.role === "assistant"
                  ? { ...entry, call_id: contextUsage.callId }
                  : entry,
              ),
            );
          throw error;
        } finally {
          contextUsage.finish();
        }
      }
    } catch (error) {
      let failure = error;
      try {
        await shellExecution.stop();
      } catch (cleanupError) {
        failure = cleanupError;
      }
      await settleTools();
      const cancelled = abortSignal.aborted && failure === error;
      const exhausted =
        /context_length_exceeded|exceeds? (?:the )?(?:maximum )?context|maximum context length|prompt is too long/i.test(
          String(failure),
        );
      await store.append(session, {
        status: cancelled
          ? "cancelled"
          : exhausted
            ? "context_exhausted"
            : "failed",
        error: cancelled
          ? undefined
          : exhausted
            ? "Context exhausted. Create a new subagent task."
            : String(failure),
      });
      if (cancelled) return { status: "cancelled" };
      throw failure;
    } finally {
      await cleanup();
    }
  };
}
