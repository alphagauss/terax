/**
 * 本文件负责运行主 Agent 与通用 Subagent。
 * 它协调多段流、活动耗时、后台结果 checkpoint、工具权限和同一 turn 的最终收敛。
 */

import {
  isSubagentToolErrorOutput,
  type SubagentDisplayState,
} from "@/modules/ai/agents/subagentDisplay";
import {
  type AgentTurnCoordinator,
  releaseAgentTurnCoordinator,
  type SubagentTaskRunner,
} from "@/modules/ai/agents/subagentRuntime";
import {
  clampAgentSteps,
  getModelContextWindow,
  MAX_AGENT_STEPS_DEFAULT,
  MAX_SUBAGENT_STEPS_DEFAULT,
  type ModelRef,
  modelRefsEqual,
  normalizeMainAgentSteps,
  type ProviderBaseURLs,
  type ProviderInstance,
  type ProviderModels,
  resolveModel,
} from "@/modules/ai/config";
import {
  type AgentToolId,
  resolveSubagentTools,
} from "@/modules/ai/lib/agentTools";
import { coalesceStream } from "@/modules/ai/lib/coalesceStream";
import {
  compactionInstruction,
  planCompaction,
} from "@/modules/ai/lib/compact";
import {
  compactionConfiguration,
  generateCompaction,
} from "@/modules/ai/lib/compactionRequest";
import { createContextUsage } from "@/modules/ai/lib/contextUsage";
import {
  ACTIVITY_DURATION_PART_TYPE,
  approvalModelHistoryDelta,
  conversationEventPart,
  convertToAgentModelMessages,
  expandConversationMessages,
  modelHistoryPart,
  REASONING_DURATION_PART_TYPE,
  type TurnEvent,
} from "@/modules/ai/lib/conversation";
import { peekFileEditRuntime } from "@/modules/ai/lib/fileEditRuntime";
import { describeToolCall } from "@/modules/ai/lib/toolSummary";
import type {
  ProviderInstanceKeys,
  ProviderKeys,
} from "@/modules/ai/lib/keyring";
import {
  buildParameterOptions,
  type ParameterAssignment,
} from "@/modules/ai/lib/modelParameters";
import {
  type PreparedAgentPrompt,
  prepareAgentPrompt,
} from "@/modules/ai/lib/prompt";
import {
  buildConfiguredLanguageModel,
  createProviderDownload,
} from "@/modules/ai/lib/providerRuntime";
import { usageRecords } from "@/modules/ai/lib/usageRuntime";
import SUBAGENT_PROMPT from "@/modules/ai/prompts/subagent";
import { getProvider } from "@/modules/ai/providerRegistry";
import { buildToolApproval } from "@/modules/ai/tools/approval";
import { buildTools, type ToolContext } from "@/modules/ai/tools/tools";
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

export type RunAgentOptions = {
  modelParameters?: ParameterAssignment[];
  getSubagentConfiguration?: (
    parentModel: ModelRef,
  ) => SubagentModelConfiguration;
  keys: ProviderKeys;
  model: ModelRef;
  systemPrompt: string;
  allowedTools: readonly AgentToolId[];
  maxAgentSteps?: number | null;
  maxSubagentSteps?: number;
  maxConcurrentSubagents: number;
  turnCoordinator: AgentTurnCoordinator;
  toolContext: ToolContext;
  turnId: string;
  compactOnly?: string;
  getCompactionConfiguration?: (
    model: ModelRef,
    parameters: ParameterAssignment[],
  ) => SubagentModelConfiguration;
  onCompacting?: (compacting: boolean) => void;
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

/** 子任务发起时读取的模型配置，不包含父任务的权限与执行上下文。 */
export type SubagentModelConfiguration = Pick<
  RunAgentOptions,
  | "model"
  | "modelParameters"
  | "keys"
  | "providerBaseURLs"
  | "providerModels"
  | "customProviders"
  | "providerInstanceKeys"
>;

const SUBAGENT_STEP_LIMIT_SUMMARY_PROMPT = `The Subagent has reached its tool-step limit. Do not call any more tools. Based only on the task, conversation, and tool results already available, provide a concise partial report with: completed work, confirmed findings or evidence, unresolved items, and recommended next steps. Clearly state that the task is incomplete and do not claim full completion.`;
const EMPTY_RESPONSE_RECOVERY_PROMPT = `The previous response did not include a valid tool call or a user-visible final answer. Continue the current task. Use the provided structured tools if more work is needed; otherwise provide the final answer to the user.`;
const EMPTY_RESPONSE_ERROR =
  "The model returned neither a valid tool call nor a final response after retrying.";
const MAX_EMPTY_RESPONSE_RETRIES = 1;

function hasVisibleAssistantText(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== "assistant") return false;
    if (typeof message.content === "string")
      return message.content.trim().length > 0;
    return message.content.some(
      (part) => part.type === "text" && part.text.trim().length > 0,
    );
  });
}

/**
 * 使用冻结配置启动一次可跨多个 provider 请求的 Agent turn。
 *
 * 系统提示词由会话传输层提前冻结。模型初始化前等待调用方持久化用户消息
 * 和该提示词；后台 Subagent 结果也会在恢复模型循环前 checkpoint。
 */
export async function runAgentStream(opts: RunAgentOptions) {
  const maxAgentSteps = normalizeMainAgentSteps(
    opts.maxAgentSteps === undefined
      ? MAX_AGENT_STEPS_DEFAULT
      : opts.maxAgentSteps,
  );
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
          const last =
            opts.compactOnly === undefined
              ? originalMessages[originalMessages.length - 1]
              : undefined;
          // 仅保留当前响应的完整 part 前缀，使 checkpoint 与最终 SDK 消息共用显式游标。
          let completedMessage = last?.role === "assistant" ? last : undefined;
          const approvalHistory = approvalModelHistoryDelta(
            completedMessage,
            modelHistory,
          );
          if (completedMessage && approvalHistory.length) {
            const part = modelHistoryPart(approvalHistory);
            completedMessage = {
              ...completedMessage,
              parts: [...completedMessage.parts, part],
            };
            writer.write(part as UIMessageChunk);
          }
          let stepsSeen = 0;
          let emptyResponseRetries = 0;
          let streamStarted = false;
          let finishReason: FinishReason = "stop";
          let approvalPending = false;
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

          const liveMessages = () => {
            if (!completedMessage) return opts.uiMessages;
            return opts.uiMessages[opts.uiMessages.length - 1]?.id ===
              completedMessage.id
              ? [...opts.uiMessages.slice(0, -1), completedMessage]
              : [...opts.uiMessages, completedMessage];
          };
          let lastPrompt: PreparedAgentPrompt | undefined;
          const compact = async (manual: boolean) => {
            const plan = planCompaction(
              expandConversationMessages(liveMessages()),
              !manual,
            );
            if (!plan) return;
            const configuration = compactionConfiguration(opts);
            const durationMs = finishActivity();
            if (durationMs !== undefined && completedMessage)
              completedMessage.parts.push({
                type: ACTIVITY_DURATION_PART_TYPE,
                data: { durationMs },
              });
            opts.onCompacting?.(true);
            try {
              const summary = await generateCompaction({
                configuration,
                sessionId: opts.toolContext.getSessionId(),
                turnId: opts.turnId,
                systemPrompt: opts.systemPrompt,
                messages: modelHistory,
                cachedPrefix: modelRefsEqual(configuration.model, opts.model)
                  ? lastPrompt
                  : undefined,
                tools: rootTools,
                instruction: compactionInstruction(
                  plan,
                  opts.compactOnly ?? "",
                ),
                signal: opts.abortSignal,
              });
              opts.abortSignal?.throwIfAborted();
              await appendEvent(completedMessage ? [completedMessage] : [], {
                event: "compaction",
                id: crypto.randomUUID(),
                throughUserMessageId: plan.throughUserMessageId,
                summary,
              });
              lastPrompt = undefined;
              modelHistory.splice(
                0,
                modelHistory.length,
                ...(await convertToAgentModelMessages(liveMessages())),
              );
            } finally {
              opts.onCompacting?.(false);
            }
          };
          const compactIfNeeded = async () => {
            const previous = [...usageRecords(opts.toolContext.getSessionId())]
              .reverse()
              .find((record) => !record.taskId && !record.purpose);
            if (
              previous &&
              previous.values.inputTokens + previous.values.outputTokens >=
                getModelContextWindow(modelRef, opts.providerModels ?? {}) * 0.8
            )
              await compact(false);
          };
          const appendEvent = async (
            completedMessages: UIMessage[],
            event: TurnEvent,
          ) => {
            opts.abortSignal?.throwIfAborted();
            await opts.onCheckpoint(completedMessages, event);
            if (!streamStarted) {
              writer.write({
                type: "start",
                ...(opts.compactOnly !== undefined
                  ? { messageId: crypto.randomUUID() }
                  : {}),
              });
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
            if (opts.compactOnly !== undefined) {
              await compact(true);
              coordinator.inbox.close();
              writer.setOutcome({ status: "completed" });
              writer.write({ type: "finish", finishReason: "stop" });
              coordinator.reset();
              releaseAgentTurnCoordinator(
                opts.toolContext.getSessionId(),
                coordinator,
              );
              return;
            }
            coordinator.inbox.open();
            // SDK 只从末尾 tool 消息收集审批响应；先插入引导会让批准或拒绝失效。
            let resolvingApprovals =
              last?.role === "assistant" &&
              last.parts.some(
                (part) =>
                  "state" in part && part.state === "approval-responded",
              );
            if (!resolvingApprovals) await compactIfNeeded();
            const initialAppend = resolvingApprovals
              ? null
              : appendPendingEvents();
            if (initialAppend) await initialAppend;

            const reachedStepCap = () =>
              maxAgentSteps !== null && stepsSeen >= maxAgentSteps;
            while (!reachedStepCap()) {
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
                tools: rootTools,
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
              lastPrompt = prompt;
              const cycle: {
                message?: UIMessage;
                outcome: UIMessageStreamOutcome;
                terminal?: Extract<UIMessageChunk, { type: "error" | "abort" }>;
              } = { outcome: { status: "unknown" } };
              let reasoningStartedAt: number | undefined;
              let cycleSteps = 0;
              const result = streamText({
                ...buildParameterOptions(
                  opts.modelParameters ?? [],
                  getProvider(provider).runtime.adapter,
                  provider,
                ),
                prepareStep: contextUsage.prepareStep,
                model,
                experimental_download: createProviderDownload(
                  modelRef.providerId,
                  opts.abortSignal,
                ),
                instructions: prompt.instructions,
                messages: prompt.messages,
                tools: rootTools,
                toolApproval: buildToolApproval(opts.toolContext),
                // 每个完整工具步骤后返回运行时，由同一边界处理压缩、引导与步骤上限。
                stopWhen: isStepCount(1),
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
                  cycleWriter.write(
                    modelHistoryPart(
                      await result.responseMessages,
                    ) as UIMessageChunk,
                  );
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
                (reachedCandidateEnd || reachedStepCap());
              if (mustDrainBackground) {
                await coordinator.inbox.waitUntil(coordinator.waitForAll());
              }

              if (
                !approvalPending &&
                resultFinishReason === "tool-calls" &&
                !reachedStepCap()
              ) {
                await compactIfNeeded();
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
                emptyResponseRetries = 0;
                continue;
              }
              if (resultFinishReason === "tool-calls") {
                emptyResponseRetries = 0;
                continue;
              }
              if (!hasVisibleAssistantText(response)) {
                if (
                  resultFinishReason === "stop" &&
                  emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES
                ) {
                  emptyResponseRetries++;
                  // 仅在既有模型事实尾部追加恢复指令，保持 system、工具和历史前缀不变。
                  const recoveryMessage: ModelMessage = {
                    role: "user",
                    content: EMPTY_RESPONSE_RECOVERY_PROMPT,
                  };
                  const recoveryPart = modelHistoryPart([recoveryMessage]);
                  modelHistory.push(recoveryMessage);
                  completedMessage = {
                    id: completedMessage?.id ?? "turn",
                    role: "assistant",
                    parts: [...(completedMessage?.parts ?? []), recoveryPart],
                  };
                  writer.write(recoveryPart as UIMessageChunk);
                  continue;
                }
                throw new Error(EMPTY_RESPONSE_ERROR);
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
              hitStepCap: reachedStepCap(),
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
  permissionMode,
}: {
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
  return async ({ taskId, task, abortSignal, onProgress }) => {
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
    const model = config.model;
    const childModel = await buildConfiguredLanguageModel(model, config.keys, {
      providerBaseURLs: config.providerBaseURLs,
      customProviders: config.customProviders,
      providerInstanceKeys: config.providerInstanceKeys,
    });
    const provider = resolveModel(model, {
      customProviders: config.customProviders,
      providerBaseURLs: config.providerBaseURLs,
    }).provider;
    const prompt = prepareAgentPrompt(
      `${opts.systemPrompt}\n\n${SUBAGENT_PROMPT}`,
      [{ role: "user", content: task }],
      provider,
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
            summary: describeToolCall(toolName, input, false),
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
      contextWindow: getModelContextWindow(model, config.providerModels ?? {}),
      instructions: prompt.instructions,
      tools,
    });
    let lastChildMessages = prompt.messages;
    const result = streamText({
      ...buildParameterOptions(
        config.modelParameters ?? [],
        getProvider(provider).runtime.adapter,
        provider,
      ),
      prepareStep: ({ messages }) => {
        lastChildMessages = prepareAgentPrompt("", messages, provider).messages;
        return contextUsage.prepareStep({ messages: lastChildMessages });
      },
      model: childModel,
      experimental_download: createProviderDownload(
        model.providerId,
        abortSignal,
      ),
      instructions: prompt.instructions,
      messages: prompt.messages,
      tools,
      toolApproval: buildToolApproval(toolContext),
      stopWhen: isStepCount(maxSubagentSteps),
      abortSignal,
      onStepStart: () => {
        onProgress({ type: "thinking" });
      },
      onToolExecutionStart: ({ toolCall }) => {
        onProgress({
          type: "tool-start",
          id: toolCall.toolCallId,
          toolName: toolCall.toolName,
          summary: describeToolCall(
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
      const [text, finishReason, responseMessages] = await Promise.all([
        result.text,
        result.finishReason,
        result.responseMessages,
      ]);
      if (finishReason === "tool-calls") {
        onProgress({ type: "thinking" });
        const summaryUsage = await createContextUsage({
          sessionId: opts.toolContext.getSessionId(),
          turnId: opts.turnId,
          taskId,
          model,
          contextWindow: getModelContextWindow(
            model,
            config.providerModels ?? {},
          ),
          instructions: prompt.instructions,
          tools,
        });
        const summary = streamText({
          ...buildParameterOptions(
            config.modelParameters ?? [],
            getProvider(provider).runtime.adapter,
            provider,
          ),
          prepareStep: summaryUsage.prepareStep,
          model: childModel,
          experimental_download: createProviderDownload(
            model.providerId,
            abortSignal,
          ),
          instructions: prompt.instructions,
          messages: [
            ...lastChildMessages,
            ...[...prompt.messages, ...responseMessages].slice(
              lastChildMessages.length,
            ),
            { role: "user", content: SUBAGENT_STEP_LIMIT_SUMMARY_PROMPT },
          ],
          tools: Object.fromEntries(
            Object.entries(tools).map(([name, definition]) => {
              const { execute: _execute, ...tool } = definition;
              delete tool.onInputStart;
              delete tool.onInputDelta;
              delete tool.onInputAvailable;
              return [name, tool];
            }),
          ),
          stopWhen: isStepCount(1),
          abortSignal,
          onLanguageModelCallEnd: (event) =>
            summaryUsage.finish(event.usage, event.content, event.performance),
        });
        try {
          for await (const chunk of summary.stream) {
            summaryUsage.observe(chunk);
            if (chunk.type === "error") throw chunk.error;
          }
          abortSignal.throwIfAborted();
          const summaryText = await summary.text;
          return {
            status: "incomplete",
            ...(summaryText || text ? { result: summaryText || text } : {}),
            error:
              "Subagent reached its step limit before completing the task.",
          };
        } finally {
          summaryUsage.finish();
        }
      }
      return {
        status: "completed",
        result: text || "Task completed but no final response was generated.",
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
