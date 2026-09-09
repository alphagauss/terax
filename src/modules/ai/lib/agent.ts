/**
 * 本文件负责运行主 Agent 与通用 Subagent。
 * 它协调多段流、活动耗时、后台结果 checkpoint、工具权限和同一 turn 的最终收敛。
 */

import SUBAGENT_PROMPT from "@/modules/ai/prompts/subagent";
import {
  isSubagentToolErrorOutput,
  type SubagentDisplayState,
  summarizeSubagentToolInput,
} from "@/modules/ai/agents/subagentDisplay";
import {
  type AgentTurnCoordinator,
  releaseAgentTurnCoordinator,
  type SubagentTaskRunner,
} from "@/modules/ai/agents/subagentRuntime";
import {
  getModelContextWindow,
  MAX_AGENT_STEPS,
  type ModelRef,
  type ProviderBaseURLs,
  type ProviderInstance,
  type ProviderModels,
  resolveModel,
} from "@/modules/ai/config";
import { coalesceStream } from "@/modules/ai/lib/coalesceStream";
import {
  type AgentToolId,
  resolveSubagentTools,
} from "@/modules/ai/lib/agentTools";
import {
  ACTIVITY_DURATION_PART_TYPE,
  conversationEventPart,
  convertToAgentModelMessages,
  REASONING_DURATION_PART_TYPE,
  type TurnEvent,
} from "@/modules/ai/lib/conversation";
import type {
  ProviderInstanceKeys,
  ProviderKeys,
} from "@/modules/ai/lib/keyring";
import { prepareAgentPrompt } from "@/modules/ai/lib/prompt";
import {
  buildConfiguredLanguageModel,
  createProviderDownload,
} from "@/modules/ai/lib/providerRuntime";
import { buildToolApproval } from "@/modules/ai/tools/approval";
import { buildTools, type ToolContext } from "@/modules/ai/tools/tools";
import { peekFileEditRuntime } from "@/modules/ai/lib/fileEditRuntime";
import {
  createUIMessageStream,
  type FinishReason,
  isStepCount,
  type ModelMessage,
  pruneMessages,
  streamText,
  toUIMessageChunk,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamOutcome,
  type UIMessageStreamWriter,
} from "ai";
import { createContextUsage } from "@/modules/ai/lib/contextUsage";

export type RunAgentOptions = {
  keys: ProviderKeys;
  model: ModelRef;
  systemPrompt: string;
  allowedTools: readonly AgentToolId[];
  defaultSubagentModel?: ModelRef | null;
  maxConcurrentSubagents: number;
  turnCoordinator: AgentTurnCoordinator;
  toolContext: ToolContext;
  turnId: string;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  onSubagentDisplay?: (state: SubagentDisplayState) => void;
  onSystemPrompt?: (
    systemPrompt: string,
    messages: UIMessage[],
  ) => void | Promise<void>;
  onCheckpoint: (
    completedMessages: UIMessage[],
    event: TurnEvent,
  ) => void | Promise<void>;
  providerBaseURLs?: Readonly<ProviderBaseURLs>;
  providerModels?: Readonly<ProviderModels>;
  customProviders?: readonly ProviderInstance[];
  providerInstanceKeys?: ProviderInstanceKeys;
  uiMessages: UIMessage[];
  abortSignal?: AbortSignal;
};

/**
 * 使用冻结配置启动一次可跨多个 provider 请求的 Agent turn。
 *
 * 系统提示词由会话传输层提前冻结。模型初始化前等待调用方持久化用户消息
 * 和该提示词；后台 Subagent 结果也会在恢复模型循环前 checkpoint。
 */
export async function runAgentStream(opts: RunAgentOptions) {
  const modelRef = opts.model;
  const providerConfig = {
    customProviders: opts.customProviders,
    providerBaseURLs: opts.providerBaseURLs,
  };
  const info = resolveModel(modelRef, providerConfig);
  const provider = info.provider;

  await opts.onSystemPrompt?.(opts.systemPrompt, opts.uiMessages);

  const history = await convertToAgentModelMessages(opts.uiMessages);
  const prunedHistory = pruneMessages({
    messages: history,
    reasoning: "none",
    emptyMessages: "remove",
  });
  const model = await buildConfiguredLanguageModel(modelRef, opts.keys, {
    providerBaseURLs: opts.providerBaseURLs,
    customProviders: opts.customProviders,
    providerInstanceKeys: opts.providerInstanceKeys,
  });

  const subagentModel = opts.defaultSubagentModel ?? modelRef;
  const coordinator = opts.turnCoordinator;
  const rootTools = buildTools(
    opts.toolContext,
    opts.allowedTools,
    ({ task, label, toolCallId, wait, abortSignal }) => {
      const permissionMode = opts.toolContext.getPermissionMode();
      return coordinator.start({
        task,
        label,
        toolCallId,
        wait,
        limit: opts.maxConcurrentSubagents,
        parentAbortSignal: abortSignal,
        onDisplay: opts.onSubagentDisplay,
        run: buildSubagentTaskRunner({
          opts,
          model: subagentModel,
          permissionMode,
        }),
      });
    },
  );

  return {
    toUIMessageStream({
      originalMessages = opts.uiMessages,
      onError = (error: unknown) => String(error),
    }: {
      originalMessages?: UIMessage[];
      onError?: (error: unknown) => string;
    } = {}) {
      const stream = createUIMessageStream<UIMessage>({
        originalMessages,
        onError,
        execute: async ({ writer }) => {
          const modelHistory: ModelMessage[] = [...prunedHistory];
          const last = originalMessages[originalMessages.length - 1];
          // 仅保留当前响应的完整 part 前缀，使 checkpoint 与最终 SDK 消息共用显式游标。
          let completedMessage = last?.role === "assistant" ? last : undefined;
          let stepsSeen = 0;
          let streamStarted = false;
          let finishReason: FinishReason = "stop";
          let approvalPending = false;
          let finalizationOnly = false;
          let activityStartedAt: number | undefined;
          const abort = () => void coordinator.cancelAll();
          opts.abortSignal?.addEventListener("abort", abort, { once: true });

          const finishActivity = (
            target: UIMessageStreamWriter = writer,
          ): number | undefined => {
            if (activityStartedAt === undefined) return undefined;
            const durationMs = Math.max(
              0,
              Math.round(performance.now() - activityStartedAt),
            );
            activityStartedAt = undefined;
            target.write({
              type: ACTIVITY_DURATION_PART_TYPE,
              data: { durationMs },
            });
            return durationMs;
          };

          const appendEvent = async (
            completedMessages: UIMessage[],
            event: TurnEvent,
          ) => {
            opts.abortSignal?.throwIfAborted();
            await opts.onCheckpoint(completedMessages, event);
            if (!streamStarted) {
              writer.write({ type: "start" });
              streamStarted = true;
            }
            const part = conversationEventPart(event);
            writer.write(part);
            completedMessage = {
              id: completedMessage?.id ?? "turn",
              role: "assistant",
              parts: [...(completedMessage?.parts ?? []), part],
            };
            modelHistory.push(
              ...(await convertToAgentModelMessages([
                { id: "event", role: "assistant", parts: [part] },
              ])),
            );
          };

          /** 接入与持久化串行执行，后到的用户引导优先于尚未消费的后台结果。 */
          const appendPendingEvents = (): Promise<boolean> | null => {
            const first = coordinator.inbox.take();
            if (!first) return null;
            return (async () => {
              let entry: typeof first | null = first;
              while (entry) {
                try {
                  await appendEvent(
                    completedMessage ? [completedMessage] : [],
                    entry.event,
                  );
                  entry.settle("consumed");
                } catch (error) {
                  entry.settle("cancelled");
                  throw error;
                }
                entry = coordinator.inbox.take();
              }
              return true;
            })();
          };

          let contextUsage:
            | Awaited<ReturnType<typeof createContextUsage>>
            | undefined;
          try {
            opts.abortSignal?.throwIfAborted();
            coordinator.inbox.open();
            // SDK 只从末尾 tool 消息收集审批响应；先插入引导会让批准或拒绝失效。
            let resolvingApprovals =
              last?.role === "assistant" &&
              last.parts.some(
                (part) =>
                  "state" in part && part.state === "approval-responded",
              );
            const initialAppend = resolvingApprovals
              ? null
              : appendPendingEvents();
            if (initialAppend) await initialAppend;

            while (stepsSeen < MAX_AGENT_STEPS || finalizationOnly) {
              contextUsage = await createContextUsage({
                sessionId: opts.toolContext.getSessionId(),
                turnId: opts.turnId,
                model: modelRef,
                contextWindow: getModelContextWindow(
                  modelRef,
                  opts.providerModels ?? {},
                ),
                instructions: prepareAgentPrompt(
                  opts.systemPrompt,
                  [],
                  provider,
                ).instructions,
                tools: finalizationOnly ? undefined : rootTools,
                onCompact: opts.onCompact,
              });
              // 最后一次空检查与 streamText 调用之间不能 await，否则刚完成的
              // 结果可能在微任务间隙越过本次 provider 请求边界。
              while (!resolvingApprovals) {
                const pendingAppend = appendPendingEvents();
                if (!pendingAppend) break;
                await pendingAppend;
              }
              const prompt = prepareAgentPrompt(
                opts.systemPrompt,
                modelHistory,
                provider,
              );
              const cycle: {
                message?: UIMessage;
                outcome: UIMessageStreamOutcome;
                terminal?: Extract<UIMessageChunk, { type: "error" | "abort" }>;
              } = { outcome: { status: "unknown" } };
              let reasoningStartedAt: number | undefined;
              let cycleSteps = 0;
              const result = streamText({
                prepareStep: contextUsage.prepareStep,
                model,
                experimental_download: createProviderDownload(
                  modelRef.providerId,
                  opts.abortSignal,
                ),
                instructions: prompt.instructions,
                messages: prompt.messages,
                tools: finalizationOnly ? undefined : rootTools,
                toolApproval: buildToolApproval(opts.toolContext),
                stopWhen: finalizationOnly
                  ? isStepCount(1)
                  : ({ steps }) =>
                      stepsSeen + steps.length >= MAX_AGENT_STEPS ||
                      coordinator.inbox.hasPending,
                abortSignal: opts.abortSignal,
                onLanguageModelCallEnd: (event) =>
                  contextUsage?.finish(
                    event.usage,
                    event.content,
                    event.performance,
                  ),
                onStepEnd: () => {
                  cycleSteps++;
                },
              });
              // SDK 从实际输出流构造 checkpoint，耗时与历史前缀不再手工回填。
              const uiStream = createUIMessageStream<UIMessage>({
                originalMessages: completedMessage
                  ? [completedMessage]
                  : originalMessages,
                onError,
                onEnd: ({ responseMessage, outcome }) => {
                  cycle.message = responseMessage;
                  cycle.outcome = outcome;
                },
                execute: async ({ writer: cycleWriter }) => {
                  for await (const part of result.stream) {
                    contextUsage?.observe(part);
                    if (part.type === "error") throw part.error;
                    if (part.type === "finish")
                      cycleWriter.setOutcome({ status: "completed" });
                    if (part.type === "abort")
                      cycleWriter.setOutcome({ status: "aborted" });
                    const chunk = toUIMessageChunk(part, {
                      tools: rootTools,
                      sendStart: !streamStarted,
                      sendFinish: false,
                      onError,
                    });
                    if (!chunk) continue;
                    if (chunk.type === "reasoning-start") {
                      reasoningStartedAt = performance.now();
                      activityStartedAt ??= performance.now();
                    }
                    const toolName =
                      chunk.type === "tool-input-start" ||
                      chunk.type === "tool-input-available" ||
                      chunk.type === "tool-input-error"
                        ? chunk.toolName
                        : null;
                    // 空白正文不结束工具活动，Subagent 则是独立展示边界。
                    if (
                      (chunk.type === "text-delta" &&
                        chunk.delta.trim().length > 0) ||
                      toolName === "run_subagent"
                    ) {
                      finishActivity(cycleWriter);
                    } else if (toolName !== null) {
                      activityStartedAt ??= performance.now();
                    }
                    cycleWriter.write(chunk);
                    if (
                      chunk.type === "reasoning-end" &&
                      reasoningStartedAt !== undefined
                    ) {
                      cycleWriter.write({
                        type: REASONING_DURATION_PART_TYPE,
                        data: {
                          durationMs: Math.max(
                            0,
                            Math.round(performance.now() - reasoningStartedAt),
                          ),
                        },
                      });
                      reasoningStartedAt = undefined;
                    }
                  }
                },
              });
              await uiStream.pipeTo(
                new WritableStream({
                  write: (chunk) => {
                    // 错误与中止会触发 Chat 收尾，必须等后台任务清理后再发布。
                    if (chunk.type === "error" || chunk.type === "abort")
                      cycle.terminal = chunk;
                    else writer.write(chunk);
                  },
                }),
              );
              contextUsage.finish();
              if (
                cycle.outcome.status === "failed" ||
                cycle.outcome.status === "aborted"
              ) {
                writer.setOutcome(cycle.outcome);
                finishActivity();
                await coordinator.cancelAll();
                releaseAgentTurnCoordinator(
                  opts.toolContext.getSessionId(),
                  coordinator,
                );
                if (cycle.terminal) writer.write(cycle.terminal);
                return;
              }
              if (cycle.message) completedMessage = cycle.message;
              streamStarted = true;
              resolvingApprovals = false;

              const [response, resultFinishReason] = await Promise.all([
                result.responseMessages,
                result.finishReason,
              ]);
              modelHistory.push(...response);
              stepsSeen += cycleSteps;
              finishReason = resultFinishReason;
              approvalPending = hasApprovalRequest(cycle.message);

              const reachedCandidateEnd = resultFinishReason !== "tool-calls";
              const mustDrainBackground =
                !approvalPending &&
                coordinator.runningCount > 0 &&
                (reachedCandidateEnd || stepsSeen >= MAX_AGENT_STEPS);
              if (mustDrainBackground) {
                await coordinator.inbox.waitUntil(coordinator.waitForAll());
              }

              let completed = false;
              if (!approvalPending && coordinator.inbox.hasPending) {
                if (!completedMessage) {
                  throw new Error("Subagent checkpoint message is unavailable");
                }
                const durationMs = finishActivity();
                if (durationMs !== undefined)
                  completedMessage.parts.push({
                    type: ACTIVITY_DURATION_PART_TYPE,
                    data: { durationMs },
                  });
                const pendingAppend = appendPendingEvents();
                completed = pendingAppend ? await pendingAppend : false;
              }

              if (approvalPending) break;
              if (completed) {
                finalizationOnly = stepsSeen >= MAX_AGENT_STEPS;
                continue;
              }
              break;
            }

            if (!approvalPending) coordinator.inbox.close();
            finishActivity();
            writer.setOutcome({ status: "completed" });
            writer.write({
              type: "finish",
              finishReason,
            });
            opts.onFinishMeta?.({
              hitStepCap: stepsSeen >= MAX_AGENT_STEPS,
              finishReason,
            });
            if (!approvalPending) {
              coordinator.reset();
              releaseAgentTurnCoordinator(
                opts.toolContext.getSessionId(),
                coordinator,
              );
            }
          } catch (error) {
            contextUsage?.finish();
            finishActivity();
            await coordinator.cancelAll();
            releaseAgentTurnCoordinator(
              opts.toolContext.getSessionId(),
              coordinator,
            );
            throw error;
          } finally {
            opts.abortSignal?.removeEventListener("abort", abort);
          }
        },
      });
      return coalesceStream(stream);
    },
  };
}

/** 按启动时权限快照创建一个不含递归能力的 Subagent runner。 */
function buildSubagentTaskRunner({
  opts,
  model,
  permissionMode,
}: {
  opts: RunAgentOptions;
  model: ModelRef;
  permissionMode: "ask" | "full-access";
}): SubagentTaskRunner {
  const allowedTools = resolveSubagentTools(opts.allowedTools, permissionMode);
  const toolContext: ToolContext = {
    ...opts.toolContext,
    getPermissionMode: () => permissionMode,
    // Subagent 没有独立审批通道，越界调用应由原生边界返回明确错误。
    supportsApprovals: false,
  };
  return async ({ taskId, task, abortSignal, onProgress }) => {
    const childModel = await buildConfiguredLanguageModel(model, opts.keys, {
      providerBaseURLs: opts.providerBaseURLs,
      customProviders: opts.customProviders,
      providerInstanceKeys: opts.providerInstanceKeys,
    });
    const prompt = prepareAgentPrompt(
      `${opts.systemPrompt}\n\n${SUBAGENT_PROMPT}`,
      [{ role: "user", content: task }],
      resolveModel(model, {
        customProviders: opts.customProviders,
        providerBaseURLs: opts.providerBaseURLs,
      }).provider,
    );
    const tools = buildTools(
      {
        ...toolContext,
        fileEditTaskId: taskId,
        onFileEditInput: (id, toolName, input) => {
          onProgress({
            type: "tool-start",
            id,
            toolName,
            summary: summarizeSubagentToolInput(toolName, input),
          });
        },
      },
      allowedTools,
    );
    const contextUsage = await createContextUsage({
      sessionId: opts.toolContext.getSessionId(),
      turnId: opts.turnId,
      taskId,
      model,
      contextWindow: getModelContextWindow(model, opts.providerModels ?? {}),
      instructions: prompt.instructions,
      tools,
    });
    const result = streamText({
      prepareStep: contextUsage.prepareStep,
      model: childModel,
      experimental_download: createProviderDownload(
        model.providerId,
        abortSignal,
      ),
      instructions: prompt.instructions,
      messages: prompt.messages,
      tools,
      toolApproval: buildToolApproval(toolContext),
      stopWhen: isStepCount(MAX_AGENT_STEPS),
      abortSignal,
      onStepStart: () => {
        onProgress({ type: "thinking" });
      },
      onToolExecutionStart: ({ toolCall }) => {
        onProgress({
          type: "tool-start",
          id: toolCall.toolCallId,
          toolName: toolCall.toolName,
          summary: summarizeSubagentToolInput(
            toolCall.toolName,
            toolCall.input,
          ),
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
    try {
      for await (const chunk of result.stream) {
        contextUsage.observe(chunk);
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
      abortSignal.throwIfAborted();
      return {
        status: "completed",
        result:
          (await result.text) ||
          "Task completed but no final response was generated.",
      };
    } finally {
      contextUsage.finish();
      peekFileEditRuntime(opts.toolContext.getSessionId())?.finishTask(taskId);
    }
  };
}

function hasApprovalRequest(message: UIMessage | undefined): boolean {
  return Boolean(
    message?.parts.some(
      (part) =>
        "state" in part &&
        (part as { state?: string }).state === "approval-requested",
    ),
  );
}
